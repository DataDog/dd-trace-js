'use strict'

const HttpClientPlugin = require('../../datadog-plugin-http/src/client')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class ElectronNetPlugin extends CompositePlugin {
  static id = 'electron:net'
  static get plugins () {
    return {
      request: ElectronRequestPlugin,
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

    const requestHeaders = ctx.req._urlLoaderOptions?.headers
    if (requestHeaders) {
      for (const header in requestHeaders) {
        reqHeaders[header.name] = header.value
      }
    }

    const responseHeaders = responseHead?.rawHeaders
    if (responseHeaders) {
      for (const header in responseHeaders) {
        resHeaders[header.name] = header.value
      }
    }

    ctx.req = { headers: reqHeaders }
    ctx.res = { headers: resHeaders, statusCode }

    this.finish(ctx)
  }
}

module.exports = ElectronNetPlugin
