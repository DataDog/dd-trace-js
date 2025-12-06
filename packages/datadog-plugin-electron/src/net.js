'use strict'

const HttpClientPlugin = require('../../datadog-plugin-http/src/client')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class ElectronNetPlugin extends CompositePlugin {
  static id = 'electron:net'
  static get plugins () {
    return {
      request: ElectronRequestPlugin
    }
  }
}

class ElectronRequestPlugin extends HttpClientPlugin {
  static id = 'electron:net:request'
  static component = 'electron'
  static operation = 'request'
  static prefix = 'tracing:apm:electron:net:request'

  bindStart (ctx) {
    const args = ctx.args

    let options = args[0]

    if (typeof options === 'string') {
      options = args[0] = { url: options }
    } else if (!options) {
      options = args[0] = {}
    }

    const headers = options.headers || {}

    try {
      if (typeof options === 'string') {
        options = new URL(options)
      } else if (options.url) {
        options = new URL(options.url)
      }
    } catch {
      // leave options as-is
    }

    options.headers = headers
    ctx.args = { options }

    const store = super.bindStart(ctx)

    ctx.args = args

    for (const name in options.headers) {
      if (!headers[name]) {
        args[0].headers ??= {}
        args[0].headers[name] = options.headers[name]
      }
    }

    return store
  }

  asyncStart (ctx) {
    const reqHeaders = {}
    const resHeaders = {}
    const responseHead = ctx.res?._responseHead
    const { statusCode } = responseHead || {}

    for (const header in ctx.req._urlLoaderOptions?.headers || {}) {
      reqHeaders[header.name] = header.value
    }

    for (const header in responseHead?.rawHeaders || {}) {
      resHeaders[header.name] = header.value
    }

    ctx.req = { headers: reqHeaders }
    ctx.res = { headers: resHeaders, statusCode }

    this.finish(ctx)
  }
}

module.exports = ElectronNetPlugin
