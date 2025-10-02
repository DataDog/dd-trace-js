'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing.js')
const tags = require('../../../ext/tags.js')

const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE

class WSServerPlugin extends TracingPlugin {
  static get id () { return 'ws' }
  static get prefix () { return 'tracing:ws:server:connect' }
  static get type () { return 'websocket' }
  static get kind () { return 'request' }

  bindStart (ctx) {
    const req = ctx.req

    const options = {}
    const headers = Object.entries(req.headers)
    options.headers = Object.fromEntries(headers)
    options.method = req.method

    const protocol = `${getRequestProtocol(req)}:`
    const host = options.headers.host
    const path = req.url.split('?')[0]
    const uri = `${protocol}//${host}${path}`

    ctx.args = { options }

    const service = this.serviceName({ pluginConfig: this.config })
    const span = this.startSpan(this.operationName(), {
      service,
      meta: {
        'span.type': 'websocket',
        'http.upgraded': 'websocket',
        'http.method': options.method,
        'http.url': uri,
        'resource.name': `${options.method} ${path}`,
        'span.kind': 'server'

      }

    }, ctx)
    ctx.span = span

    ctx.socket.spanContext = ctx.span._spanContext
    ctx.socket.spanContext.spanTags = ctx.span._spanContext._tags

    return ctx.currentStore
  }

  bindAsyncStart (ctx) {
    ctx.span.setTag(HTTP_STATUS_CODE, ctx.req.resStatus)

    return ctx.parentStore
  }

  asyncStart (ctx) {
    ctx.span.finish()
  }
}

function getRequestProtocol (req, fallback = 'ws') {
  // 1. Check if the underlying TLS socket has 'encrypted'
  if (req.socket && req.socket.encrypted) {
    return 'wss'
  }

  // 2. Check for a trusted header set by a proxy
  if (req.headers && req.headers['x-forwarded-proto']) {
    const proto = req.headers['x-forwarded-proto'].split(',')[0].trim()
    if (proto === 'https') return 'wss'
    if (proto === 'http') return 'ws'
  }

  // 3. Fallback to ws
  return fallback
}

module.exports = WSServerPlugin
