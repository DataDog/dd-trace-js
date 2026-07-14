'use strict'

const { storage } = require('../../datadog-core')
const ServerPlugin = require('../../dd-trace/src/plugins/server')
const web = require('../../dd-trace/src/plugins/util/web')
const { MANUAL_DROP } = require('../../../ext/tags')

const legacyStorage = storage('legacy')

class NitroPlugin extends ServerPlugin {
  static id = 'nitro'
  static operation = 'request'
  static prefix = 'tracing:h3.request'

  bindStart (ctx) {
    if (!this.#isRequest(ctx)) return legacyStorage.getStore()

    const req = this.#getWebRequest(ctx)
    const meta = this.getTags(ctx)
    const childOf = this.activeSpan ? undefined : this.#extractChildOf(req)

    const span = this.startSpan(this.operationName(), {
      type: 'web',
      kind: 'server',
      meta,
      childOf,
      service: this.config.service || this.serviceName(),
    }, ctx)

    if (req) {
      this.#setWebContext(ctx, req, span)
      this.#applyFilter(req, span)
    }

    return ctx.currentStore
  }

  getTags (ctx) {
    const event = ctx?.event
    const req = event?.req
    const meta = {
      component: 'nitro',
      'span.kind': 'server',
    }

    if (!req) return meta

    if (req.method) meta['http.method'] = req.method

    const route = this.#getRoute(event)
    if (route) meta['http.route'] = route

    return meta
  }

  getResource (ctx) {
    const event = ctx?.event
    const method = event?.req?.method
    const route = this.#getRoute(event)

    if (method && route) return `${method} ${route}`
    return method
  }

  #getRoute (event) {
    return event?.context?.matchedRoute?.route
  }

  #extractChildOf (req) {
    return req?.headers ? this.tracer.extract('http_headers', req.headers) || undefined : undefined
  }

  #getStatus (ctx) {
    const result = ctx?.result
    if (this.#isResponseLike(result)) return result.status

    if (ctx?.event?.res?.status !== undefined) return ctx.event.res.status
    if (ctx?.error) return ctx.error.status ?? ctx.error.statusCode ?? 500

    return 200
  }

  #finishWebSpan (ctx) {
    const context = ctx?.webContext
    if (!context?.span) return false

    const route = this.#getRoute(ctx?.event)
    context.paths = route ? [route] : []
    context.res = this.#getWebResponse(ctx, this.#getStatus(ctx))

    if (ctx?.error) {
      context.error = ctx.error
      context.span.setTag('error', ctx.error)
    }

    web.finishSpan(context, web.TYPE)
    return true
  }

  end (ctx) {
    if (!this.#isRequest(ctx)) return
    this.finish(ctx)
  }

  // h3's tracingChannel emits both 'end' (sync completion) and 'asyncEnd' (promise
  // resolution). Either fires for a given request; both go through the same finalization.
  asyncEnd (ctx) {
    this.end(ctx)
  }

  error (ctx) {
    if (!this.#isRequest(ctx)) return
    const span = ctx?.currentStore?.span
    const error = ctx?.error
    if (span && error) {
      span.setTag('error', error)
    }
  }

  finish (ctx) {
    if (!this.#isRequest(ctx) || (!Object.hasOwn(ctx, 'result') && !Object.hasOwn(ctx, 'error'))) return
    if (this.#finishWebSpan(ctx)) return
    super.finish(ctx)
  }

  configure (config) {
    return super.configure(web.normalizeConfig(config))
  }

  #isRequest (ctx) {
    return ctx?.type === 'request'
  }

  #isResponseLike (value) {
    return value && typeof value === 'object' && typeof value.status === 'number' &&
      value.headers && typeof value.headers.get === 'function'
  }

  #setWebContext (ctx, req, span) {
    const context = web.patch(req)
    context.tracer = this.tracer
    context.span = span
    context.config = this.config
    ctx.webContext = context
  }

  #applyFilter (req, span) {
    if (this.config.filter(req.url)) return

    span.setTag(MANUAL_DROP, true)
    span.context()._trace.isRecording = false
  }

  #getWebRequest (ctx) {
    const event = ctx?.event
    const req = event?.req
    const url = this.#getRequestUrl(event)

    if (!req || !url) return

    const headers = this.#getRequestHeaders(req.headers)
    const normalizedUrl = this.#normalizeRequestUrl(url, headers)

    return {
      method: req.method,
      headers,
      socket: normalizedUrl.socket,
      url: normalizedUrl.url,
    }
  }

  #getRequestUrl (event) {
    const url = event?.req?.url || event?.url?.href

    if (url === undefined) return
    return typeof url === 'string' ? url : String(url)
  }

  #normalizeRequestUrl (url, headers) {
    if (url.charCodeAt(0) === 47) return { url }

    try {
      const parsed = new URL(url)
      headers.host ??= parsed.host

      return {
        socket: parsed.protocol === 'https:' ? { encrypted: true } : undefined,
        url: `${parsed.pathname}${parsed.search}`,
      }
    } catch {
      return { url }
    }
  }

  #getRequestHeaders (rawHeaders) {
    const headers = {}
    if (!rawHeaders) return headers

    const entries = typeof rawHeaders.entries === 'function'
      ? rawHeaders.entries()
      : Object.entries(rawHeaders)

    for (const [key, value] of entries) {
      headers[key.toLowerCase()] = value
    }

    return headers
  }

  #getWebResponse (ctx, statusCode) {
    return {
      statusCode,
      getHeader: name => this.#getResponseHeader(ctx, name),
    }
  }

  #getResponseHeader (ctx, name) {
    return this.#getHeader(ctx?.result?.headers, name) || this.#getHeader(ctx?.event?.res?.headers, name)
  }

  #getHeader (headers, name) {
    if (!headers) return
    if (typeof headers.get === 'function') return headers.get(name)

    return headers[name] ?? headers[name.toLowerCase()]
  }
}

module.exports = NitroPlugin
