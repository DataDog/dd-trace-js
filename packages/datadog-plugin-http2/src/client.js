'use strict'

const URL = require('url').URL
const opentracing = require('opentracing')
const log = require('../../dd-trace/src/log')
const constants = require('../../dd-trace/src/constants')
const tags = require('../../../ext/tags')
const kinds = require('../../../ext/kinds')
const formats = require('../../../ext/formats')
const urlFilter = require('../../dd-trace/src/plugins/util/urlfilter')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const shimmer = require('../../datadog-shimmer')

const Reference = opentracing.Reference

const HTTP_HEADERS = formats.HTTP_HEADERS
const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE
const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS
const SPAN_KIND = tags.SPAN_KIND
const CLIENT = kinds.CLIENT
const REFERENCE_CHILD_OF = opentracing.REFERENCE_CHILD_OF
const REFERENCE_NOOP = constants.REFERENCE_NOOP

const HTTP2_HEADER_METHOD = ':method'
const HTTP2_HEADER_PATH = ':path'
const HTTP2_HEADER_STATUS = ':status'
const HTTP2_METHOD_GET = 'GET'

function extractSessionDetails (authority, options) {
  if (typeof authority === 'string') {
    authority = new URL(authority)
  }

  const protocol = authority.protocol || options.protocol || 'https:'
  let port = '' + (authority.port !== ''
    ? authority.port : (authority.protocol === 'http:' ? 80 : 443))
  let host = authority.hostname || authority.host || 'localhost'

  if (protocol === 'https:' && options) {
    port = options.port || port
    host = options.host || host
  }

  return { protocol, port, host }
}

function getFormattedHostString (host, port) {
  return [host, port].filter(val => val).join(':')
}

function getServiceName (tracer, config, sessionDetails) {
  if (config.splitByDomain) {
    return getFormattedHostString(sessionDetails.host, sessionDetails.port)
  } else if (config.service) {
    return config.service
  }

  return `${tracer._service}-http-client`
}

function hasAmazonSignature (headers, path) {
  if (headers) {
    headers = Object.keys(headers)
      .reduce((prev, next) => Object.assign(prev, {
        [next.toLowerCase()]: headers[next]
      }), {})

    if (headers['x-amz-signature']) {
      return true
    }

    if ([].concat(headers['authorization']).some(startsWith('AWS4-HMAC-SHA256'))) {
      return true
    }
  }

  return path && path.toLowerCase().indexOf('x-amz-signature=') !== -1
}

function startsWith (searchString) {
  return value => String(value).startsWith(searchString)
}

function getStatusValidator (config) {
  if (typeof config.validateStatus === 'function') {
    return config.validateStatus
  } else if (config.hasOwnProperty('validateStatus')) {
    log.error('Expected `validateStatus` to be a function.')
  }
  return code => code < 400 || code >= 500
}

function getFilter (tracer, config) {
  const blocklist = tracer._url ? [`${tracer._url.href}/v0.4/traces`] : []

  config = Object.assign({}, config, {
    blocklist: blocklist.concat(config.blocklist || [])
  })

  return urlFilter.getFilter(config)
}

function normalizeConfig (tracer, config) {
  config = config.client || config

  const validateStatus = getStatusValidator(config)
  const filter = getFilter(tracer, config)
  const headers = getHeaders(config)

  return Object.assign({}, config, {
    validateStatus,
    filter,
    headers
  })
}

function addResponseTags (headers, span, config) {
  const status = headers && headers[HTTP2_HEADER_STATUS]

  span.setTag(HTTP_STATUS_CODE, status)

  if (!config.validateStatus(status)) {
    span.setTag('error', 1)
  }

  addHeaderTags(span, headers, HTTP_RESPONSE_HEADERS, config)
}

function addRequestTags (headers, span, config) {
  addHeaderTags(span, headers, HTTP_REQUEST_HEADERS, config)
}

function addErrorTags (span, error) {
  span.setTag('error', error)
}

function addHeaderTags (span, headers, prefix, config) {
  if (!headers) return

  config.headers.forEach(key => {
    const value = headers[key]

    if (value) {
      span.setTag(`${prefix}.${key}`, value)
    }
  })
}

function getHeaders (config) {
  if (!Array.isArray(config.headers)) return []

  return config.headers
    .filter(key => typeof key === 'string')
    .map(key => key.toLowerCase())
}

function startSpan (tracer, config, headers, sessionDetails) {
  headers = headers || {}

  const scope = tracer.scope()
  const childOf = scope.active()

  const path = headers[HTTP2_HEADER_PATH] || '/'
  const method = headers[HTTP2_HEADER_METHOD] || HTTP2_METHOD_GET
  const url = `${sessionDetails.protocol}//${sessionDetails.host}:${sessionDetails.port}${path}`

  const type = config.filter(url) ? REFERENCE_CHILD_OF : REFERENCE_NOOP

  const span = tracer.startSpan('http.request', {
    references: [
      new Reference(type, childOf)
    ],
    tags: {
      [SPAN_KIND]: CLIENT,
      'service.name': getServiceName(tracer, config, sessionDetails),
      'resource.name': method,
      'span.type': 'http',
      'http.method': method,
      'http.url': url.split('?')[0]
    }
  })

  if (!hasAmazonSignature(headers, path)) {
    tracer.inject(span, HTTP_HEADERS, headers)
  }

  analyticsSampler.sample(span, config.measured)
  return span
}

function createWrapEmit (tracer, config, span) {
  return function wrapEmit (emit) {
    return function emitWithTrace (event, arg1) {
      switch (event) {
        case 'response':
          addResponseTags(arg1, span, config)
          break
        case 'error':
          addErrorTags(span, arg1)
        case 'close': // eslint-disable-line no-fallthrough
          span.finish()
          break
      }
      return emit.apply(this, arguments)
    }
  }
}

function createWrapRequest (tracer, config, sessionDetails) {
  return function wrapRequest (request) {
    if (!sessionDetails) return request

    return function requestWithTrace (headers, options) {
      const scope = tracer.scope()
      const span = startSpan(tracer, config, headers, sessionDetails)

      addRequestTags(headers, span, config)

      const req = scope.bind(request, span).apply(this, arguments)

      shimmer.wrap(req, 'emit', createWrapEmit(tracer, config, span))
      scope.bind(req)

      return req
    }
  }
}

function createWrapConnect (tracer, config) {
  config = normalizeConfig(tracer, config)

  return function wrapConnect (connect) {
    return function connectWithTrace (authority, options) {
      const session = connect.apply(this, arguments)

      const sessionDetails = extractSessionDetails(authority, options)

      shimmer.wrap(session, 'request', createWrapRequest(tracer, config, sessionDetails))
      return session
    }
  }
}

module.exports = [
  {
    name: 'http2',
    patch: function (http2, tracer, config) {
      if (config.client === false) return

      this.wrap(http2, 'connect', createWrapConnect(tracer, config))
    },
    unpatch: function (http2) {
      this.unwrap(http2, 'connect')
    }
  }
]
