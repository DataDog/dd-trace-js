'use strict'

const { storage } = require('../../datadog-core')
const ServerPlugin = require('../../dd-trace/src/plugins/server')
const web = require('../../dd-trace/src/plugins/util/web')

const legacyStorage = storage('legacy')

class NitroPlugin extends ServerPlugin {
  static id = 'nitro'
  static operation = 'request'
  static prefix = 'tracing:h3.request'

  bindStart (ctx) {
    if (!this.#isRequest(ctx)) return legacyStorage.getStore()

    const meta = this.getTags(ctx)
    const resource = this.getResource(ctx)
    const childOf = this.activeSpan ? undefined : this.#extractChildOf(ctx)

    this.startSpan(this.operationName(), {
      type: 'web',
      kind: 'server',
      meta,
      resource,
      childOf,
      service: this.config.service || this.serviceName(),
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
    return event?.context?.matchedRoute?.route
  }

  #extractChildOf (ctx) {
    // event.req.headers is a Web Headers object in h3 v2; convert to plain object for extract.
    const rawHeaders = ctx?.event?.req?.headers
    // Check for entries method instead of instanceof Headers for Node.js 18 compatibility.
    const isHeadersObject = rawHeaders && typeof rawHeaders.entries === 'function'
    const headers = isHeadersObject ? Object.fromEntries(rawHeaders) : rawHeaders

    return headers ? this.tracer.extract('http_headers', headers) || undefined : undefined
  }

  #getStatus (ctx) {
    const result = ctx?.result
    if (result && typeof result === 'object' && typeof result.status === 'number') return result.status

    if (ctx?.event?.res?.status !== undefined) return ctx.event.res.status
    if (ctx?.error) return ctx.error.status ?? ctx.error.statusCode ?? 500

    return 200
  }

  #applyResponseTags (ctx) {
    const span = ctx?.currentStore?.span
    if (!span) return

    const resource = this.getResource(ctx)
    if (resource) span.setTag('resource.name', resource)

    const route = this.#getRoute(ctx?.event)
    if (route) span.setTag('http.route', route)

    const status = this.#getStatus(ctx)
    span.setTag('http.status_code', String(status))

    if (ctx?.error) {
      span.setTag('error', ctx.error)
    } else if (!this.config.validateStatus(status)) {
      span.setTag('error', true)
    }

    this.config.hooks.request(span, ctx.event?.req, ctx.result)
  }

  end (ctx) {
    if (!this.#isRequest(ctx)) return
    this.#applyResponseTags(ctx)
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
    if (!this.#isRequest(ctx) || (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error'))) return
    super.finish(ctx)
  }

  configure (config) {
    return super.configure(web.normalizeConfig(config))
  }

  #isRequest (ctx) {
    return ctx?.type === 'request'
  }
}

module.exports = NitroPlugin
