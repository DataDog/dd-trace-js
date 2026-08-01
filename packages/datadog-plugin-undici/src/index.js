'use strict'

const HttpClientPlugin = require('../../datadog-plugin-http/src/client')
const { storage } = require('../../datadog-core')
const tags = require('../../../ext/tags')
const formats = require('../../../ext/formats')
const HTTP_HEADERS = formats.HTTP_HEADERS
const log = require('../../dd-trace/src/log')
const { buildClientHttpUrl } = require('../../dd-trace/src/plugins/util/url')
const { stripQueryAndFragment } = require('../../dd-trace/src/util')
const { CLIENT_PORT_KEY, SVC_SRC_KEY } = require('../../dd-trace/src/constants')

const {
  HTTP_STATUS_CODE,
  HTTP_REQUEST_HEADERS,
  HTTP_RESPONSE_HEADERS,
} = tags

const legacyStorage = storage('legacy')
const DISPATCH_PREFIX = 'tracing:orchestrion:undici:Client_dispatch'
const UPGRADE_PREFIX = 'tracing:orchestrion:undici:Request_onUpgrade'

/**
 * @typedef {import('../../dd-trace/src/opentracing/span')} DatadogSpan
 * @typedef {Record<string, unknown> & { span?: DatadogSpan }} Store
 * @typedef {Store & { span: DatadogSpan }} SpanStore
 * @typedef {object} DispatchContext
 * @property {Store} currentStore
 * @property {Store} [parentStore]
 * @property {unknown} [error]
 * @property {boolean} [opaque]
 * @property {string | URL} [origin]
 * @property {DispatchContext} dispatchContext
 * @property {boolean} [hasUpgradeHook]
 * @property {RequestContext} [requestContext]
 * @typedef {object} NativeRequest
 * @property {string | URL} [origin]
 * @property {string} path
 * @property {string} method
 * @property {string} [upgrade]
 * @property {unknown} [headers]
 * @property {(name: string, value: unknown) => void} [addHeader]
 * @typedef {object} RequestContext
 * @property {boolean} finished
 * @property {boolean} hasUpgradeHook
 * @property {NativeRequest} request
 * @property {DatadogSpan} span
 * @typedef {object} NativeResponseMessage
 * @property {NativeRequest} request
 * @property {{ headers: unknown, statusCode: number }} response
 * @typedef {object} UpgradeContext
 * @property {[number, unknown]} arguments
 * @property {NativeRequest} self
 * @typedef {URL & { headers: Record<string, string>, method: string }} LegacyOptions
 * @typedef {object} LegacyFetchContext
 * @property {Request} req
 * @property {{ options: LegacyOptions }} args
 * @property {DatadogSpan | undefined} span
 * @property {Error | undefined} error
 * @property {boolean | undefined} customRequestTimeout
 * @property {Response} [result]
 * @property {Response} [res]
 * @property {SpanStore} [currentStore]
 * @typedef {{ type?: string, id?: string, kind?: string } & {
 *   pluginConfig: object,
 *   sessionDetails: { host?: string, port?: string }
 * }} ServiceNameOptions
 */

/** @type {WeakMap<NativeRequest, RequestContext>} */
const requestContexts = new WeakMap()
/** @type {WeakMap<Store, DispatchContext>} */
const dispatchContexts = new WeakMap()
/** @type {WeakSet<Store>} */
const legacyFetchStores = new WeakSet()
/** @type {WeakSet<Store>} */
const nodeFetchStores = new WeakSet()

class UndiciPlugin extends HttpClientPlugin {
  static id = 'undici'
  static prefix = DISPATCH_PREFIX

  /**
   * @param {object} tracer
   * @param {import('../../dd-trace/src/config/config-base')} tracerConfig
   */
  constructor (tracer, tracerConfig) {
    super(tracer, tracerConfig)

    this.addSub('undici:request:create', this.#onNativeRequestCreate.bind(this))
    this.addSub('undici:request:bodySent', this.#onNativeRequestBodySent.bind(this))
    this.addSub('undici:request:headers', this.#onNativeRequestHeaders.bind(this))
    this.addSub('undici:request:trailers', this.#onNativeRequestTrailers.bind(this))
    this.addSub('undici:request:error', this.#onNativeRequestError.bind(this))
    this.addSub(`${UPGRADE_PREFIX}:start`, this.#onNativeRequestUpgrade.bind(this))

    this.addSub(`${DISPATCH_PREFIX}:error`, this.#onDispatchError.bind(this))
    this.addSub('tracing:apm:fetch:request:start', this.#onNodeFetchStart.bind(this))
    this.addBind('tracing:apm:undici:fetch:start', this.#bindLegacyStart.bind(this))
    this.addSub('tracing:apm:undici:fetch:error', this.#onLegacyError.bind(this))
    this.addSub('tracing:apm:undici:fetch:asyncEnd', this.#onLegacyAsyncEnd.bind(this))
  }

  /**
   * @param {DispatchContext} ctx
   */
  bindStart (ctx) {
    ctx.dispatchContext = ctx
    const parentStore = getStore()
    if (parentStore && (legacyFetchStores.has(parentStore) || nodeFetchStores.has(parentStore))) {
      ctx.parentStore = parentStore
      ctx.currentStore = /** @type {SpanStore} */ (parentStore)
      return parentStore
    }

    const activeContext = parentStore && dispatchContexts.get(parentStore)
    if (activeContext?.opaque && !activeContext.hasUpgradeHook && !activeContext.requestContext) {
      ctx.parentStore = parentStore
      ctx.currentStore = parentStore
      ctx.dispatchContext = activeContext
      if (!ctx.opaque) activeContext.hasUpgradeHook = true
      if (ctx.origin !== undefined) activeContext.origin = ctx.origin
      return parentStore
    }

    ctx.parentStore = parentStore
    ctx.currentStore = { ...parentStore }
    ctx.hasUpgradeHook = !ctx.opaque
    dispatchContexts.set(ctx.currentStore, ctx)

    return ctx.currentStore
  }

  /**
   * @param {string} method
   * @param {DatadogSpan | null | undefined} childOf
   */
  #startRequestSpan (method, childOf) {
    return this.startSpan(this.operationName(), {
      childOf,
      meta: {
        'span.kind': 'client',
        'http.method': method,
      },
      resource: method,
      type: 'http',
    }, false)
  }

  /**
   * @param {unknown} message
   */
  #onNodeFetchStart (message) {
    const { currentStore } = /** @type {{ currentStore?: Store }} */ (message)
    if (currentStore) {
      nodeFetchStores.add(currentStore)
    }
  }

  /**
   * @param {unknown} message
   */
  #onDispatchError (message) {
    const ctx = /** @type {DispatchContext} */ (message)
    const dispatchContext = ctx.dispatchContext

    dispatchContexts.delete(dispatchContext.currentStore)
    const requestContext = dispatchContext.requestContext
    if (!requestContext) return

    dispatchContext.requestContext = undefined
    requestContexts.delete(requestContext.request)
    this.#finishRequest(requestContext, ctx.error)
  }

  /**
   * @param {unknown} message
   */
  #onNativeRequestCreate (message) {
    const { request } = /** @type {{ request: NativeRequest }} */ (message)
    const store = getStore()
    const dispatchContext = store && dispatchContexts.get(store)
    if (!dispatchContext && store && (legacyFetchStores.has(store) || nodeFetchStores.has(store))) return

    const origin = request.origin ?? dispatchContext?.origin
    const path = request.path
    const method = request.method.toUpperCase()

    let protocol = 'http:'
    let hostname = 'localhost'
    let port = ''

    if (origin) {
      const url = new URL(origin)
      protocol = url.protocol
      hostname = url.hostname
      port = url.port
    }

    const host = port ? `${hostname}:${port}` : hostname
    const base = `${protocol}//${host}`
    const pathname = stripQueryAndFragment(path)
    const uri = `${base}${pathname}`

    const allowed = this.config.filter(uri)
    const span = this.#startRequestSpan(method, store && allowed ? store.span : null)
    const otelSemantics = this.config.DD_TRACE_OTEL_SEMANTICS_ENABLED
    /** @type {ServiceNameOptions} */
    const serviceNameOptions = { pluginConfig: this.config, sessionDetails: { host: hostname, port } }
    const service = this.serviceName(serviceNameOptions)

    span.setTag('http.url', otelSemantics ? buildClientHttpUrl(this.config, base, path, uri) : uri)
    span.setTag('out.host', hostname)
    span.setTag(CLIENT_PORT_KEY, port ? Number.parseInt(port, 10) : undefined)
    this.setServiceName(span, service.name)
    if (service.source !== undefined) {
      span.setTag(SVC_SRC_KEY, service.source)
    }

    if (!allowed) {
      span._spanContext._trace.record = false
    }

    if (request.headers && this.config.headers) {
      addConfiguredHeaders(span, request.headers, this.config.headers, HTTP_REQUEST_HEADERS)
    }

    if (this.config.propagationFilter(uri)) {
      const headers = {}
      this.tracer.inject(span, HTTP_HEADERS, headers)

      if (request.addHeader) {
        for (const [name, value] of Object.entries(headers)) {
          request.addHeader(name, value)
        }
      }
    }

    const requestContext = {
      finished: false,
      hasUpgradeHook: dispatchContext?.hasUpgradeHook === true,
      request,
      span,
    }
    requestContexts.set(request, requestContext)
    if (dispatchContext) {
      dispatchContext.requestContext = requestContext
      dispatchContexts.delete(dispatchContext.currentStore)
      // The enclosing dispatch store restores the pending context when Request construction returns.
      legacyStorage.enterWith({ ...store, span })
    }
  }

  /**
   * @param {unknown} message
   */
  #onNativeRequestBodySent (message) {
    const { request } = /** @type {{ request: NativeRequest }} */ (message)
    const ctx = requestContexts.get(request)
    if (!ctx || ctx.hasUpgradeHook || (request.method !== 'CONNECT' && !request.upgrade)) return

    this.#finishNativeRequest(request)
  }

  /**
   * @param {unknown} message
   */
  #onNativeRequestHeaders (message) {
    const { request, response } = /** @type {NativeResponseMessage} */ (message)
    const ctx = requestContexts.get(request)
    if (!ctx) return

    const { span } = ctx
    const statusCode = response.statusCode

    span.setTag(HTTP_STATUS_CODE, statusCode)
    if (!this.config.validateStatus(statusCode)) {
      span.setTag('error', 1)
    }

    addConfiguredHeaders(span, response.headers, this.config.headers, HTTP_RESPONSE_HEADERS)
  }

  /**
   * @param {unknown} message
   */
  #onNativeRequestUpgrade (message) {
    const { arguments: [statusCode, headers], self: request } = /** @type {UpgradeContext} */ (message)
    this.#onNativeRequestHeaders({
      request,
      response: { headers, statusCode },
    })
    this.#finishNativeRequest(request)
  }

  /**
   * @param {unknown} message
   */
  #onNativeRequestTrailers (message) {
    const { request } = /** @type {{ request: NativeRequest }} */ (message)
    this.#finishNativeRequest(request)
  }

  /**
   * @param {unknown} message
   */
  #onNativeRequestError (message) {
    const { request, error } = /** @type {{ request: NativeRequest, error?: Error }} */ (message)
    this.#finishNativeRequest(request, error)
  }

  /**
   * @param {NativeRequest} request
   * @param {Error} [error]
   */
  #finishNativeRequest (request, error) {
    const ctx = requestContexts.get(request)
    if (!ctx) return

    requestContexts.delete(request)
    this.#finishRequest(ctx, error)
  }

  /**
   * @param {RequestContext} ctx
   * @param {unknown} [error]
   */
  #finishRequest (ctx, error) {
    if (ctx.finished) return
    ctx.finished = true

    const { span } = ctx
    const errorName = /** @type {{ name?: string } | undefined} */ (error)?.name

    if (error && errorName !== 'AbortError') {
      span.setTag('error', error)
    }

    this.config.hooks.request(span, null, null)
    span.finish()
  }

  /**
   * @param {unknown} message
   */
  #bindLegacyStart (message) {
    const ctx = /** @type {LegacyFetchContext} */ (message)
    const req = ctx.req
    const options = /** @type {LegacyOptions} */ (new URL(req.url))
    options.headers = Object.fromEntries(req.headers.entries())
    options.method = req.method

    ctx.args = { options }

    const store = super.bindStart(ctx)
    legacyFetchStores.add(store)

    for (const name of Object.keys(options.headers)) {
      if (!req.headers.has(name)) {
        req.headers.set(name, options.headers[name])
      }
    }

    return store
  }

  /**
   * @param {unknown} message
   */
  #onLegacyError (message) {
    const ctx = /** @type {LegacyFetchContext} */ (message)
    if (!ctx.error || ctx.error.name !== 'AbortError') {
      return super.error(ctx)
    }
  }

  /**
   * @param {unknown} message
   */
  #onLegacyAsyncEnd (message) {
    const ctx = /** @type {LegacyFetchContext} */ (message)
    ctx.res = ctx.result
    return this.finish(ctx)
  }

  configure (config) {
    return super.configure(normalizeConfig(config))
  }
}

/**
 * @returns {Store | undefined}
 */
function getStore () {
  return /** @type {Store | undefined} */ (legacyStorage.getStore())
}

// Add configured headers to span with appropriate tags
function addConfiguredHeaders (span, rawHeaders, configuredHeaders, headerType) {
  const headers = normalizeHeaders(rawHeaders)

  for (const [key, tag] of configuredHeaders) {
    const value = headers[key]
    if (value) {
      span.setTag(tag || `${headerType}.${key}`, value)
    }
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
    hooks,
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
