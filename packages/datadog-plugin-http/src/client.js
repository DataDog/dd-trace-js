'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')
const { storage } = require('../../datadog-core')
const tags = require('../../../ext/tags')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const formats = require('../../../ext/formats')
const HTTP_HEADERS = formats.HTTP_HEADERS
const urlFilter = require('../../dd-trace/src/plugins/util/urlfilter')
const log = require('../../dd-trace/src/log')
const { CLIENT_PORT_KEY, COMPONENT, ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { URL } = require('url')

const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE
const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS

class HttpClientPlugin extends ClientPlugin {
  static get id () { return 'http' }
  static get prefix () { return 'apm:http:client:request' }

  bindStart (message) {
    const { args, http = {} } = message
    const store = storage.getStore()
    const options = args.options
    const agent = options.agent || options._defaultAgent || http.globalAgent || {}
    const protocol = options.protocol || agent.protocol || 'http:'
    const hostname = options.hostname || options.host || 'localhost'
    const host = options.port ? `${hostname}:${options.port}` : hostname
    const pathname = options.path || options.pathname
    const path = pathname ? pathname.split(/[?#]/)[0] : '/'
    const uri = `${protocol}//${host}${path}`

    const allowed = this.config.filter(uri)

    const method = (options.method || 'GET').toUpperCase()
    const childOf = store && allowed ? store.span : null
    // TODO delegate to super.startspan
    const span = this.startSpan(this.operationName(), {
      childOf,
      meta: {
        [COMPONENT]: this.constructor.id,
        'span.kind': 'client',
        'service.name': this.serviceName({ pluginConfig: this.config, sessionDetails: extractSessionDetails(options) }),
        'resource.name': method,
        'span.type': 'http',
        'http.method': method,
        'http.url': uri,
        'out.host': hostname
      },
      metrics: {
        [CLIENT_PORT_KEY]: parseInt(options.port)
      }
    }, false)

    // TODO: Figure out a better way to do this for any span.
    if (!allowed) {
      span._spanContext._trace.record = false
    }

    if (this.shouldInjectTraceHeaders(options, uri)) {
      this.tracer.inject(span, HTTP_HEADERS, options.headers)
    }

    analyticsSampler.sample(span, this.config.measured)

    message.span = span
    message.parentStore = store
    message.currentStore = { ...store, span }

    return message.currentStore
  }

  shouldInjectTraceHeaders (options, uri) {
    if (hasAmazonSignature(options) && !this.config.enablePropagationWithAmazonHeaders) {
      return false
    }

    if (!this.config.propagationFilter(uri)) {
      return false
    }

    return true
  }

  bindAsyncStart ({ parentStore }) {
    return parentStore
  }

  finish ({ req, res, span }) {
    if (!span) return
    if (res) {
      const status = res.status || res.statusCode

      span.setTag(HTTP_STATUS_CODE, status)

      if (!this.config.validateStatus(status)) {
        span.setTag('error', 1)
      }

      addResponseHeaders(res, span, this.config)
    }

    addRequestHeaders(req, span, this.config)

    this.config.hooks.request(span, req, res)

    this.tagPeerService(span)

    span.finish()
  }

  error ({ span, error, args, customRequestTimeout }) {
    if (!span) return
    if (error) {
      span.addTags({
        [ERROR_TYPE]: error.name,
        [ERROR_MESSAGE]: error.message || error.code,
        [ERROR_STACK]: error.stack
      })
    } else {
      // conditions for no error:
      // 1. not using a custom agent instance with custom timeout specified
      // 2. no invocation of `req.setTimeout`
      if (!args.options.agent?.options?.timeout && !customRequestTimeout) return

      span.setTag('error', 1)
    }
  }

  configure (config) {
    return super.configure(normalizeClientConfig(config))
  }
}

function addResponseHeaders (res, span, config) {
  if (!res.headers) return

  const headers = typeof res.headers.entries === 'function'
    ? Object.fromEntries(res.headers.entries())
    : res.headers

  config.headers.forEach(([key, tag]) => {
    const value = headers[key]

    if (value) {
      span.setTag(tag || `${HTTP_RESPONSE_HEADERS}.${key}`, value)
    }
  })
}

function addRequestHeaders (req, span, config) {
  const headers = req.headers && typeof req.headers.entries === 'function'
    ? Object.fromEntries(req.headers.entries())
    : req.headers || req.getHeaders()

  config.headers.forEach(([key, tag]) => {
    const value = Array.isArray(headers[key]) ? headers[key].toString() : headers[key]

    if (value) {
      span.setTag(tag || `${HTTP_REQUEST_HEADERS}.${key}`, value)
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
    .map(h => h.split(':'))
    .map(([key, tag]) => [key.toLowerCase(), tag])
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

    if ([].concat(headers.authorization).some(startsWith('AWS4-HMAC-SHA256'))) {
      return true
    }
  }

  const search = options.search || options.path

  return search && search.toLowerCase().indexOf('x-amz-signature=') !== -1
}

function extractSessionDetails (options) {
  if (typeof options === 'string') {
    return new URL(options).host
  }

  const host = options.hostname || options.host || 'localhost'
  const port = options.port

  return { host, port }
}

function startsWith (searchString) {
  return value => String(value).startsWith(searchString)
}

module.exports = HttpClientPlugin
