'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')

class NitroH3ServerPlugin extends ServerPlugin {
  static id = 'nitro'
  static operation = 'request'
  static prefix = 'tracing:h3.request'

  bindStart (ctx) {
    const meta = this.getTags(ctx)
    const resource = this.getResource(ctx)

    this.startSpan(this.operationName(), {
      type: 'web',
      kind: 'server',
      meta,
      resource,
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

    const method = req.method
    if (method) meta['http.method'] = method

    const url = req.url || event?.url?.href
    if (url) meta['http.url'] = typeof url === 'string' ? url : String(url)

    const path = event?.url?.pathname || event?.path
    if (path) meta['http.route'] = path

    return meta
  }

  getResource (ctx) {
    const event = ctx?.event
    const method = event?.req?.method
    const path = event?.url?.pathname || event?.path

    if (method && path) return `${method} ${path}`
    return method
  }

  #applyResponseTags (ctx) {
    const span = ctx?.currentStore?.span
    const status = ctx?.event?.res?.status

    if (span && status !== undefined) {
      span.setTag('http.status_code', String(status))
    }
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

  // You may modify this method, but the guard below is REQUIRED and MUST NOT be removed!
  finish (ctx) {
    // CRITICAL GUARD - DO NOT REMOVE: Ensures span only finishes when operation completes
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }
}

module.exports = {
  NitroH3ServerPlugin,
}
