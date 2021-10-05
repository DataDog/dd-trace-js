'use strict'

const url = require('url')
const opentracing = require('opentracing')
const log = require('../../dd-trace/src/log')
const constants = require('../../dd-trace/src/constants')
const tags = require('../../../ext/tags')
const kinds = require('../../../ext/kinds')
const formats = require('../../../ext/formats')
const urlFilter = require('../../dd-trace/src/plugins/util/urlfilter')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const diagnosticsChannel = require('diagnostics_channel')

const Reference = opentracing.Reference

const HTTP_HEADERS = formats.HTTP_HEADERS
const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE
const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS
const SPAN_KIND = tags.SPAN_KIND
const CLIENT = kinds.CLIENT
const REFERENCE_CHILD_OF = opentracing.REFERENCE_CHILD_OF
const REFERENCE_NOOP = constants.REFERENCE_NOOP

function addError (span, error) {
  span.addTags({
    'error.type': error.name,
    'error.msg': error.message,
    'error.stack': error.stack
  })
  return error
}

function parseHeaders (headers) {
  const pairs = headers
    .split('\r\n')
    .map((r) => r.split(':').map((str) => str.trim()))

  const object = {}
  pairs.forEach(([key, value]) => {
    key = key.toLowerCase()
    if (!value) {
      return
    }
    if (object[key]) {
      if (!Array.isArray(object[key])) {
        object[key] = [object[key], value]
      } else {
        object[key].push(value)
      }
    } else {
      object[key] = value
    }
  })
  return object
}

function diagnostics (tracer, config) {
  config = normalizeConfig(tracer, config)

  const requestChannel = diagnosticsChannel.channel('undici:request:create')
  const headersChannel = diagnosticsChannel.channel('undici:request:headers')
  const requestErrorChannel = diagnosticsChannel.channel(
    'undici:request:error'
  )

  // We use a weakmap here to store the request / spans
  const requestSpansMap = new WeakMap()

  requestChannel.subscribe(handleRequestCreate)
  requestErrorChannel.subscribe(handleRequestError)
  headersChannel.subscribe(handleRequestHeaders)

  function handleRequestCreate ({ request }) {
    const method = (request.method || 'GET').toUpperCase()

    const scope = tracer.scope()
    const childOf = scope.active()
    const path = request.path ? request.path.split(/[?#]/)[0] : '/'
    const uri = `${request.origin}${path}`
    const type = config.filter(uri) ? REFERENCE_CHILD_OF : REFERENCE_NOOP

    const span = tracer.startSpan('http.request', {
      references: [new Reference(type, childOf)],
      tags: {
        [SPAN_KIND]: CLIENT,
        'resource.name': method,
        'span.type': 'http',
        'http.method': method,
        'http.url': uri,
        'service.name': getServiceName(tracer, config, request)
      }
    })

    requestSpansMap.set(request, span)

    if (!(hasAmazonSignature(request) || !config.propagationFilter(uri))) {
      const injectedHeaders = {}
      tracer.inject(span, HTTP_HEADERS, injectedHeaders)
      Object.entries(injectedHeaders).forEach(([key, value]) => {
        request.addHeader(key, value)
      })
    }

    analyticsSampler.sample(span, config.measured)
  }

  function handleRequestError ({ request, error }) {
    const span = requestSpansMap.get(request)
    addError(span, error)
    finish(request, null, span, config)
  }

  function handleRequestHeaders ({ request, response }) {
    const span = requestSpansMap.get(request)
    finish(request, response, span, config)
  }

  return function unsubscribe () {
    if (requestChannel.hasSubscribers) {
      requestChannel.unsubscribe(handleRequestCreate)
    }
    if (headersChannel.hasSubscribers) {
      headersChannel.unsubscribe(handleRequestHeaders)
    }
    if (requestErrorChannel.hasSubscribers) {
      requestErrorChannel.unsubscribe(handleRequestError)
    }
  }
}

function addRequestHeaders (req, span, config) {
  const headers = parseHeaders(req.headers)
  Object.entries(headers).forEach(([key, value]) => {
    span.setTag(`${HTTP_REQUEST_HEADERS}.${key}`, value)
  })

  if (!headers.host) {
    // req.servername holds the value of the host header
    if (req.servername) {
      span.setTag(`${HTTP_REQUEST_HEADERS}.host`, req.servername)
    } else {
      // Undici's host header are written directly
      // to the stream, and not passed to the `Request` object
      // This workaround ensure we set the host if
      // it was not explicitely provided
      const { hostname, port } = url.parse(req.origin)
      const host = `${hostname}${port ? `:${port}` : ''}`
      span.setTag(`${HTTP_REQUEST_HEADERS}.host`, host)
    }
  }
}

function addResponseHeaders (res, span, config) {
  const resHeader = res.headers.map((x) => x.toString())
  while (resHeader.length) {
    const key = resHeader.shift()
    const value = resHeader.shift()
    span.setTag(`${HTTP_RESPONSE_HEADERS}.${key}`, value)
  }
}

function finish (req, res, span, config) {
  if (res) {
    span.setTag(HTTP_STATUS_CODE, res.statusCode)

    if (!config.validateStatus(res.statusCode)) {
      span.setTag('error', 1)
    }

    addResponseHeaders(res, span, config)
  } else {
    span.setTag('error', 1)
  }

  addRequestHeaders(req, span, config)

  config.hooks.request(span, req, res)

  span.finish()
}

function getHost (options) {
  return url.parse(options.origin).host
}

function getServiceName (tracer, config, options) {
  if (config.splitByDomain) {
    return getHost(options)
  } else if (config.service) {
    return config.service
  }

  return `${tracer._service}-http-client`
}

function hasAmazonSignature (options) {
  if (!options) {
    return false
  }

  if (options.headers) {
    let headers = {}
    if (typeof options.headers === 'string') {
      headers = parseHeaders(options.headers)
    } else {
      headers = Object.keys(options.headers).reduce(
        (prev, next) =>
          Object.assign(prev, {
            [next.toLowerCase()]: options.headers[next]
          }),
        {}
      )
    }

    if (headers['x-amz-signature']) {
      return true
    }

    if (
      [].concat(headers['authorization']).some(startsWith('AWS4-HMAC-SHA256'))
    ) {
      return true
    }
  }

  return (
    options.path &&
    options.path.toLowerCase().indexOf('x-amz-signature=') !== -1
  )
}

function startsWith (searchString) {
  return (value) => String(value).startsWith(searchString)
}

function getStatusValidator (config) {
  if (typeof config.validateStatus === 'function') {
    return config.validateStatus
  } else if (config.hasOwnProperty('validateStatus')) {
    log.error('Expected `validateStatus` to be a function.')
  }
  return (code) => code < 400 || code >= 500
}

function getFilter (tracer, config) {
  const blocklist = tracer._url ? [getAgentFilter(tracer._url)] : []

  config = Object.assign({}, config, {
    blocklist: blocklist.concat(config.blocklist || [])
  })

  return urlFilter.getFilter(config)
}

function getAgentFilter (url) {
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#Escaping
  const agentFilter = url.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  return RegExp(`^${agentFilter}.*$`, 'i')
}

function normalizeConfig (tracer, config) {
  const validateStatus = getStatusValidator(config)
  const filter = getFilter(tracer, config)
  const propagationFilter = getFilter(tracer, {
    blocklist: config.propagationBlocklist
  })
  const headers = getHeaders(config)
  const hooks = getHooks(config)

  return Object.assign({}, config, {
    validateStatus,
    filter,
    propagationFilter,
    headers,
    hooks
  })
}

function getHeaders (config) {
  if (!Array.isArray(config.headers)) return []

  return config.headers
    .filter((key) => typeof key === 'string')
    .map((key) => key.toLowerCase())
}

function getHooks (config) {
  const noop = () => {}
  const request = (config.hooks && config.hooks.request) || noop

  return { request }
}

module.exports = [
  {
    name: 'undici',
    versions: ['>=4.7.1-alpha'],
    patch: function (_, tracer, config) {
      this.unpatch = diagnostics.call(this, tracer, config)
    }
  }
]
