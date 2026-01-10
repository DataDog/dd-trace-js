'use strict'

const HttpClientPlugin = require('../../datadog-plugin-http/src/client')
const { storage } = require('../../datadog-core')
const tags = require('../../../ext/tags')
const formats = require('../../../ext/formats')
const HTTP_HEADERS = formats.HTTP_HEADERS
const log = require('../../dd-trace/src/log')
const { CLIENT_PORT_KEY, ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE
const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS

// Symbol to store span context on the native undici request object
const kSpanContext = Symbol('ddSpanContext')

class UndiciPlugin extends HttpClientPlugin {
  static id = 'undici'
  static prefix = 'tracing:apm:undici:fetch'

  constructor (...args) {
    super(...args)

    // Subscribe to native undici diagnostic channels for undici >= 4.7.0
    // These channels fire for ALL undici requests (fetch, request, stream, etc.)
    this.addSub('undici:request:create', this._onNativeRequestCreate.bind(this))
    this.addSub('undici:request:headers', this._onNativeRequestHeaders.bind(this))
    this.addSub('undici:request:trailers', this._onNativeRequestTrailers.bind(this))
    this.addSub('undici:request:error', this._onNativeRequestError.bind(this))
  }

  // ===========================================
  // Native undici diagnostic channel handlers
  // These fire for undici >= 4.7.0 for ALL request types (fetch, request, stream, etc.)
  // ===========================================

  _onNativeRequestCreate ({ request }) {
    if (!request) return

    const store = storage('legacy').getStore()
    const origin = request.origin || ''
    const path = request.path || '/'
    const method = (request.method || 'GET').toUpperCase()

    // Parse origin to extract protocol, hostname, port
    let protocol = 'http:'
    let hostname = 'localhost'
    let port = ''

    try {
      const url = new URL(origin)
      protocol = url.protocol
      hostname = url.hostname
      port = url.port
    } catch {
      // If origin is not a valid URL, use defaults
    }

    const host = port ? `${hostname}:${port}` : hostname
    const pathname = path.split(/[?#]/)[0]
    const uri = `${protocol}//${host}${pathname}`

    const allowed = this.config.filter(uri)
    const childOf = store && allowed ? store.span : null

    const span = this.startSpan(this.operationName(), {
      childOf,
      meta: {
        'span.kind': 'client',
        'http.method': method,
        'http.url': uri,
        'out.host': hostname
      },
      metrics: {
        [CLIENT_PORT_KEY]: port ? Number.parseInt(port, 10) : undefined
      },
      service: this.serviceName({ pluginConfig: this.config, sessionDetails: { host: hostname, port } }),
      resource: method,
      type: 'http'
    }, false)

    // Disable recording if not allowed
    if (!allowed) {
      span._spanContext._trace.record = false
    }

    // Capture request headers if configured
    if (request.headers && this.config.headers) {
      const headers = normalizeHeaders(request.headers)

      for (const [key, tag] of this.config.headers) {
        const value = headers[key]
        if (value) {
          span.setTag(tag || `${HTTP_REQUEST_HEADERS}.${key}`, value)
        }
      }
    }

    // Inject trace headers if propagation is allowed
    if (this._shouldInjectHeaders(uri)) {
      const headers = {}
      this.tracer.inject(span, HTTP_HEADERS, headers)

      // Use addHeader if available (undici provides this on the request object)
      if (typeof request.addHeader === 'function') {
        for (const [name, value] of Object.entries(headers)) {
          request.addHeader(name, value)
        }
      }
    }

    // Store span context on request for later retrieval
    request[kSpanContext] = {
      span,
      store,
      uri
    }

    // Enter the span context
    storage('legacy').enterWith({ ...store, span })
  }

  _onNativeRequestHeaders ({ request, response }) {
    const ctx = request?.[kSpanContext]
    if (!ctx) return

    const { span } = ctx
    const statusCode = response?.statusCode

    if (statusCode) {
      span.setTag(HTTP_STATUS_CODE, statusCode)

      if (!this.config.validateStatus(statusCode)) {
        span.setTag('error', 1)
      }
    }

    // Add response headers if configured
    if (response?.headers && this.config.headers) {
      const headers = normalizeHeaders(response.headers)

      for (const [key, tag] of this.config.headers) {
        const value = headers[key]
        if (value) {
          span.setTag(tag || `${HTTP_RESPONSE_HEADERS}.${key}`, value)
        }
      }
    }
  }

  _onNativeRequestTrailers ({ request }) {
    const ctx = request?.[kSpanContext]
    if (!ctx) return

    const { span, store } = ctx

    // Call the request hook if configured
    this.config.hooks.request(span, null, null)

    // Finish the span
    span.finish()

    // Clean up
    delete request[kSpanContext]

    // Restore parent store
    if (store) {
      storage('legacy').enterWith(store)
    }
  }

  _onNativeRequestError ({ request, error }) {
    const ctx = request?.[kSpanContext]
    if (!ctx) return

    const { span, store } = ctx

    // Don't record AbortError as an error - it's user-initiated cancellation
    if (error && error.name !== 'AbortError') {
      span.addTags({
        error: 1,
        [ERROR_TYPE]: error.name,
        [ERROR_MESSAGE]: error.message || error.code,
        [ERROR_STACK]: error.stack
      })
    }

    // Call the request hook if configured
    this.config.hooks.request(span, null, null)

    // Finish the span
    span.finish()

    // Clean up
    delete request[kSpanContext]

    // Restore parent store
    if (store) {
      storage('legacy').enterWith(store)
    }
  }

  _shouldInjectHeaders (uri) {
    return this.config.propagationFilter(uri)
  }

  // ===========================================
  // Fetch-based tracing channel handlers
  // These handle fetch() for undici < 4.7.0 (before native DC was added)
  // ===========================================

  bindStart (ctx) {
    const req = ctx.req
    const options = new URL(req.url)
    options.headers = Object.fromEntries(req.headers.entries())
    options.method = req.method

    ctx.args = { options }

    const store = super.bindStart(ctx)

    // Inject trace headers back into the request
    for (const name in options.headers) {
      if (!req.headers.has(name)) {
        req.headers.set(name, options.headers[name])
      }
    }

    return store
  }

  error (ctx) {
    // Don't record AbortError as an error - it's user-initiated cancellation
    if (ctx.error && ctx.error.name === 'AbortError') return
    return super.error(ctx)
  }

  asyncEnd (ctx) {
    ctx.res = ctx.result
    return this.finish(ctx)
  }

  configure (config) {
    return super.configure(normalizeConfig(config))
  }
}

// Normalize headers to an object, handling different undici formats:
// - Array format: alternating key-value pairs (undici >= 6.0.0)
// - String format: HTTP header lines like "key: value\r\n" (undici 5.x)
// - Object format: already a headers object
function normalizeHeaders (headers) {
  if (!headers) return {}

  // String format (undici 5.x): "key: value\r\nkey2: value2\r\n"
  if (typeof headers === 'string') {
    const result = {}
    const lines = headers.split('\r\n')
    for (const line of lines) {
      if (!line) continue
      const colonIndex = line.indexOf(':')
      if (colonIndex > 0) {
        const key = line.slice(0, colonIndex).toLowerCase().trim()
        const value = line.slice(colonIndex + 1).trim()
        result[key] = value
      }
    }
    return result
  }

  // Array format (undici >= 6.0.0): alternating key-value pairs
  if (Array.isArray(headers)) {
    const result = {}
    for (let i = 0; i < headers.length; i += 2) {
      const key = headers[i]
      if (typeof key === 'string') {
        result[key.toLowerCase()] = headers[i + 1]
      } else if (Buffer.isBuffer(key)) {
        result[key.toString().toLowerCase()] = headers[i + 1]?.toString?.() || headers[i + 1]
      }
    }
    return result
  }

  // Object format: use as-is
  return headers
}

function normalizeConfig (config) {
  const validateStatus = getStatusValidator(config)
  const hooks = getHooks(config)

  return {
    ...config,
    validateStatus,
    hooks
  }
}

function getStatusValidator (config) {
  if (typeof config.validateStatus === 'function') {
    return config.validateStatus
  } else if (Object.hasOwn(config, 'validateStatus')) {
    log.error('Expected `validateStatus` to be a function.')
  }
  return defaultValidateStatus
}

function defaultValidateStatus (code) {
  return code < 400 || code >= 500
}

function getHooks (config) {
  const request = config.hooks?.request ?? noop

  return { request }
}

function noop () {}

module.exports = UndiciPlugin
