'use strict'

const HttpClientPlugin = require('../../datadog-plugin-http/src/client')
const { readDsmBase64 } = require('../../dd-trace/src/carrier')

const DSM_HEADER = 'dd-pathway-ctx-base64'

class FetchPlugin extends HttpClientPlugin {
  static id = 'fetch'
  static prefix = 'tracing:apm:fetch:request'

  bindStart (ctx) {
    const req = ctx.req
    const options = new URL(req.url)
    options.headers = Object.fromEntries(req.headers.entries())

    options.method = req.method

    ctx.args = { options }

    const store = super.bindStart(ctx)

    // Native undici diagnostics also fire for requests already traced by this wrapper.
    store.skipUndici = true

    for (const name in options.headers) {
      if (!req.headers.has(name)) {
        req.headers.set(name, options.headers[name])
      }
    }

    // A pathway header the caller forwards describes an upstream hop, so this request's own one replaces it.
    const pathway = readDsmBase64(options.headers)
    if (pathway !== undefined) {
      req.headers.set(DSM_HEADER, pathway)
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
