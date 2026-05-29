'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')

class NitroPlugin extends ServerPlugin {
  static id = 'nitro'
  static operation = 'request'
  static prefix = 'tracing:h3.request'

  bindStart (ctx) {
    // h3's tracingPlugin wraps both route handlers (type='route') and middleware
    // (type='middleware') with the same tracingChannel. Only the matched route
    // produces a per-request HTTP server span; middleware events would create
    // duplicate spans per request.
    if (ctx?.type !== 'route') return ctx.currentStore

    const meta = this.getTags(ctx)
    const resource = this.getResource(ctx)
    // event.req.headers is a Web Headers object in h3 v2; convert to plain object for extract
    const rawHeaders = ctx?.event?.req?.headers
    // Check for entries method instead of instanceof Headers for Node.js 18 compatibility
    const isHeadersObject = rawHeaders && typeof rawHeaders.entries === 'function'
    const headers = isHeadersObject ? Object.fromEntries(rawHeaders) : rawHeaders
    const childOf = headers ? this.tracer.extract('http_headers', headers) || undefined : undefined

    this.startSpan(this.operationName(), {
      type: 'web',
      kind: 'server',
      meta,
      resource,
      childOf,
    }, ctx)

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

    const url = req.url || event?.url?.href
    if (url) meta['http.url'] = typeof url === 'string' ? url : String(url)

    // Prefer the matched route pattern (e.g. /users/:id) over actual path (e.g. /users/42).
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
    return event?.context?.matchedRoute?.route || event?.url?.pathname || event?.path
  }

  #applyResponseTags (ctx) {
    const span = ctx?.currentStore?.span
    if (!span) return

    // h3 v2 leaves event.res.status undefined for default responses (status is computed
    // inside prepareResponse() after the handler resolves). Resolve from the handler result,
    // an explicit setResponseStatus() call, or fall back to 200 / 500.
    let status
    if (ctx?.error) {
      status = ctx.error.status ?? ctx.error.statusCode ?? 500
    } else if (ctx?.result?.status === undefined) {
      status = ctx?.event?.res?.status ?? 200
    } else {
      status = ctx.result.status
    }

    span.setTag('http.status_code', String(status))
  }

  end (ctx) {
    this.#applyResponseTags(ctx)
    this.finish(ctx)
  }

  asyncEnd (ctx) {
    this.#applyResponseTags(ctx)
    this.finish(ctx)
  }

  error (ctx) {
    const span = ctx?.currentStore?.span
    const error = ctx?.error
    if (span && error) {
      span.setTag('error', error)
    }
  }

  finish (ctx) {
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return
    super.finish(ctx)
  }
}

module.exports = NitroPlugin
