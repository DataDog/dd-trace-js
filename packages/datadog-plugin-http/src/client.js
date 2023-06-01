'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')
const { storage } = require('../../datadog-core')
const tags = require('../../../ext/tags')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const formats = require('../../../ext/formats')
const HTTP_HEADERS = formats.HTTP_HEADERS
const urlFilter = require('../../dd-trace/src/plugins/util/urlfilter')
const log = require('../../dd-trace/src/log')
const url = require('url')
const { CLIENT_PORT_KEY, COMPONENT, ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE
const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS

class HttpClientPlugin extends ClientPlugin {
  static get id () {
    return 'http'
  }

  addTraceSub (eventName, handler) {
    this.addSub(`apm:${this.constructor.id}:client:${this.operation}:${eventName}`, handler)
  }

  start ({ args, http }) {
    const store = storage.getStore()
    const options = args.options
    const agent = options.agent || options._defaultAgent || http.globalAgent
    const protocol = options.protocol || agent.protocol || 'http:'
    const hostname = options.hostname || options.host || 'localhost'
    const host = options.port ? `${hostname}:${options.port}` : hostname
    const path = options.path ? options.path.split(/[?#]/)[0] : '/'
    const uri = `${protocol}//${host}${path}`
    const allowed = this.config.filter(uri)

    const method = (options.method || 'GET').toUpperCase()
    const childOf = store && allowed ? store.span : null
    // TODO delegate to super.startspan
    const span = this.startSpan('http.request', {
      childOf,
      meta: {
        [COMPONENT]: this.constructor.id,
        'span.kind': 'client',
        'service.name': getServiceName(this.tracer, this.config, options),
        'resource.name': method,
        'span.type': 'http',
        'http.method': method,
        'http.url': uri,
        'out.host': hostname
      },
      metrics: {
        [CLIENT_PORT_KEY]: parseInt(options.port)
      }
    })

    // TODO: Figure out a better way to do this for any span.
    if (!allowed) {
      span._spanContext._trace.record = false
    }

    if (!(hasAmazonSignature(options) || !this.config.propagationFilter(uri))) {
      this.tracer.inject(span, HTTP_HEADERS, options.headers)
    }

    analyticsSampler.sample(span, this.config.measured)
    this.enter(span, store)
  }

  finish ({ req, res }) {
    const span = storage.getStore().span
    if (res) {
      span.setTag(HTTP_STATUS_CODE, res.statusCode)

      if (!this.config.validateStatus(res.statusCode)) {
        span.setTag('error', 1)
      }

      addResponseHeaders(res, span, this.config)
    }

    addRequestHeaders(req, span, this.config)

    this.config.hooks.request(span, req, res)
    span.finish()
  }

  error (err) {
    const span = storage.getStore().span

    if (err) {
      span.addTags({
        [ERROR_TYPE]: err.name,
        [ERROR_MESSAGE]: err.message || err.code,
        [ERROR_STACK]: err.stack
      })
    } else {
      span.setTag('error', 1)
    }
  }

  configure (config) {
    return super.configure(normalizeClientConfig(config))
  }
}

function addResponseHeaders (res, span, config) {
  config.headers.forEach(key => {
    const value = res.headers[key]

    if (value) {
      span.setTag(`${HTTP_RESPONSE_HEADERS}.${key}`, value)
    }
  })
}

function addRequestHeaders (req, span, config) {
  config.headers.forEach(key => {
    const value = req.getHeader(key)

    if (value) {
      span.setTag(`${HTTP_REQUEST_HEADERS}.${key}`, Array.isArray(value) ? value.toString() : value)
    }
  })
}

function normalizeClientConfig (config) {
  const validateStatus = getStatusValidator(config)
  const filter = getFilter(config)
  const propagationFilter = getFilter({ blocklist: config.propagationBlocklist })
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

function getStatusValidator (config) {
  if (typeof config.validateStatus === 'function') {
    return config.validateStatus
  } else if (config.hasOwnProperty('validateStatus')) {
    log.error('Expected `validateStatus` to be a function.')
  }
  return code => code < 400 || code >= 500
}

function getFilter (config) {
  config = Object.assign({}, config, {
    blocklist: config.blocklist || []
  })

  return urlFilter.getFilter(config)
}

function getHeaders (config) {
  if (!Array.isArray(config.headers)) return []

  return config.headers
    .filter(key => typeof key === 'string')
    .map(key => key.toLowerCase())
}

function getHooks (config) {
  const noop = () => {}
  const request = (config.hooks && config.hooks.request) || noop

  return { request }
}

function hasAmazonSignature (options) {
  if (!options) {
    return false
  }

  if (options.headers) {
    const headers = Object.keys(options.headers)
      .reduce((prev, next) => Object.assign(prev, {
        [next.toLowerCase()]: options.headers[next]
      }), {})

    if (headers['x-amz-signature']) {
      return true
    }

    if ([].concat(headers['authorization']).some(startsWith('AWS4-HMAC-SHA256'))) {
      return true
    }
  }

  return options.path && options.path.toLowerCase().indexOf('x-amz-signature=') !== -1
}

function getServiceName (tracer, config, options) {
  if (config.splitByDomain) {
    return getHost(options)
  } else if (config.service) {
    return config.service
  }

  return tracer._service
}

function getHost (options) {
  if (typeof options === 'string') {
    return url.parse(options).host
  }

  const hostname = options.hostname || options.host || 'localhost'
  const port = options.port

  return [hostname, port].filter(val => val).join(':')
}

function startsWith (searchString) {
  return value => String(value).startsWith(searchString)
}

module.exports = HttpClientPlugin
