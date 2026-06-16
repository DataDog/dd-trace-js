'use strict'

const { URL } = require('url')

const ClientPlugin = require('../../dd-trace/src/plugins/client')
const { storage } = require('../../datadog-core')
const tags = require('../../../ext/tags')
const formats = require('../../../ext/formats')
const HTTP_HEADERS = formats.HTTP_HEADERS
const httpOtel = require('../../dd-trace/src/plugins/util/http-otel-semantics')
const urlFilter = require('../../dd-trace/src/plugins/util/urlfilter')
const log = require('../../dd-trace/src/log')
const { CLIENT_PORT_KEY, COMPONENT, ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE
const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS

class HttpClientPlugin extends ClientPlugin {
  static id = 'http'
  static prefix = 'apm:http:client:request'

  // In OTel-semantics mode the host is tagged as `server.address` instead of
  // `out.host`; keep it as a peer.service precursor so peer.service still resolves.
  static peerServicePrecursors = ['server.address']

  bindStart (message) {
    const { args, http = {} } = message
    const store = storage('legacy').getStore()
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

    const otelSemantics = this.config.DD_TRACE_OTEL_SEMANTICS_ENABLED
    const meta = {
      [COMPONENT]: this.component,
      'span.kind': 'client',
      'resource.name': method,
      'span.type': 'http',
    }
    const metrics = {}

    if (otelSemantics) {
      meta[httpOtel.HTTP_REQUEST_METHOD] = method
      meta[httpOtel.URL_FULL] = uri
      meta[httpOtel.SERVER_ADDRESS] = hostname
      const port = Number.parseInt(options.port)
      if (port > 0) metrics[httpOtel.SERVER_PORT] = port
    } else {
      meta['http.method'] = method
      meta['http.url'] = uri
      meta['out.host'] = hostname
      metrics[CLIENT_PORT_KEY] = Number.parseInt(options.port)
    }

    // TODO delegate to super.startspan
    const span = this.startSpan(this.operationName(), {
      childOf,
      integrationName: this.component,
      service: this.serviceName({ pluginConfig: this.config, sessionDetails: extractSessionDetails(options) }),
      meta,
      metrics,
    }, false)

    // TODO: Figure out a better way to do this for any span.
    if (!allowed) {
      span._spanContext._trace.record = false
    }

    if (this.shouldInjectTraceHeaders(options, uri)) {
      // Clone the headers object in case an upstream lib has a reference to the original headers
      // Implemented due to aws-sdk issue where request signing is broken if we mutate the headers
      // Explained further in:
      // https://github.com/open-telemetry/opentelemetry-js-contrib/issues/1609#issuecomment-1826167348
      options.headers = { ...options.headers }
      this.tracer.inject(span, HTTP_HEADERS, options.headers)
    }

    message.span = span
    message.parentStore = store
    message.currentStore = { ...store, span }

    return message.currentStore
  }

  shouldInjectTraceHeaders (options, uri) {
    return Boolean(this.config.propagationFilter(uri))
  }

  bindAsyncStart ({ parentStore }) {
    return parentStore
  }

  finish (ctx) {
    const { req, res, span } = ctx
    if (!span) return
    if (res) {
      const status = res.status || res.statusCode

      if (this.config.DD_TRACE_OTEL_SEMANTICS_ENABLED) {
        // String so it serializes to `meta` like the Datadog `http.status_code` does.
        span.setTag(httpOtel.HTTP_RESPONSE_STATUS_CODE, String(status))
      } else {
        span.setTag(HTTP_STATUS_CODE, status)
      }

      if (!this.config.validateStatus(status)) {
        span.setTag('error', 1)
        if (this.config.DD_TRACE_OTEL_SEMANTICS_ENABLED) {
          span.setTag(ERROR_TYPE, String(status))
        }
      }

      addResponseHeaders(res, span, this.config)
    }

    if (req) {
      addRequestHeaders(req, span, this.config)
    }

    this.config.hooks.request(span, req, res)

    super.finish(ctx)
  }

  error ({ span, error, args, customRequestTimeout }) {
    if (!span) return
    if (error) {
      span.addTags({
        [ERROR_TYPE]: error.name,
        [ERROR_MESSAGE]: error.message || error.code,
        [ERROR_STACK]: error.stack,
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

  for (const [key, tag] of config.headers) {
    const value = headers[key]

    if (value) {
      span.setTag(tag || `${HTTP_RESPONSE_HEADERS}.${key}`, value)
    }
  }
}

function addRequestHeaders (req, span, config) {
  const headers = req.headers && typeof req.headers.entries === 'function'
    ? Object.fromEntries(req.headers.entries())
    : req.headers || req.getHeaders()

  for (const [key, tag] of config.headers) {
    const value = Array.isArray(headers[key]) ? headers[key].toString() : headers[key]

    if (value) {
      span.setTag(tag || `${HTTP_REQUEST_HEADERS}.${key}`, value)
    }
  }
}

function normalizeClientConfig (config) {
  const validateStatus = getStatusValidator(config)
  const filter = getFilter(config)
  const propagationFilter = getFilter({ blocklist: config.propagationBlocklist })
  const headers = getHeaders(config)
  const hooks = getHooks(config)

  return {
    ...config,
    validateStatus,
    filter,
    propagationFilter,
    headers,
    hooks,
  }
}

function is400ErrorCode (code) {
  return code < 400 || code >= 500
}

function getStatusValidator (config) {
  if (typeof config.validateStatus === 'function') {
    return config.validateStatus
  } else if (config.hasOwnProperty('validateStatus')) {
    log.error('Expected `validateStatus` to be a function.')
  }
  return is400ErrorCode
}

function getFilter (config) {
  config = { ...config, blocklist: config.blocklist || [] }

  return urlFilter.getFilter(config)
}

function getHeaders (config) {
  if (!Array.isArray(config.headers)) return []

  const result = []
  for (const header of config.headers) {
    if (typeof header === 'string') {
      const separatorIndex = header.indexOf(':')
      result.push(separatorIndex === -1
        ? [header.toLowerCase(), undefined]
        : [
            header.slice(0, separatorIndex).toLowerCase(),
            header.slice(separatorIndex + 1),
          ]
      )
    }
  }
  return result
}

const noop = () => {}

function getHooks (config) {
  const request = config.hooks?.request ?? noop

  return { request }
}

function extractSessionDetails (options) {
  if (typeof options === 'string') {
    return new URL(options).host
  }

  const host = options.hostname || options.host || 'localhost'
  const port = options.port

  return { host, port }
}

module.exports = HttpClientPlugin
