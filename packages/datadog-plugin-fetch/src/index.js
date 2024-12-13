'use strict'

const HttpClientPlugin = require('../../datadog-plugin-http/src/client')

class FetchPlugin extends HttpClientPlugin {
  static get id () { return 'fetch' }
  static get prefix () { return 'tracing:apm:fetch:request' }

  bindStart (ctx) {
    const req = ctx.req
    const options = new URL(req.url)
    const headers = options.headers = Object.fromEntries(req.headers.entries())

    options.method = req.method

    ctx.args = { options }

    const store = super.bindStart(ctx)

    for (const name in headers) {
      if (!req.headers.has(name)) {
        req.headers.set(name, headers[name])
      }
    }

    return store
  }

  error (ctx) {
    if (ctx.error.name === 'AbortError') return
    return super.error(ctx)
  }

  asyncEnd (ctx) {
    ctx.res = ctx.result
    return this.finish(ctx)
  }
}

module.exports = FetchPlugin
