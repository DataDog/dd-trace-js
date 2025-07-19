'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing.js')
const tags = require('../../../ext/tags.js')

const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE

class WSServerPlugin extends TracingPlugin {
  static get id () { return 'ws' }
  static get prefix () { return 'tracing:ws:server:connect' }
  static get type () { return 'websocket' }
  static get kind () { return 'consumer' }

  // create a context that only the add link needs, just keep ids
  // for client side 921 req.on upgrade websocket.emit is emmited as an event
  bindStart (ctx) {
    const { http = {} } = ctx
    const req = ctx.req

    const options = {}
    const headers = Object.entries(req.headers)
    options.headers = Object.fromEntries(headers)
    options.method = req.method

    const agent = options['user.agent'] || {}
    const protocol = `${getRequestProtocol(req)}:`
    const hostname = options.headers.host.split(':')[0]
    const host = options.headers.host
    const path = req.url
    const uri = `${protocol}//${host}${path}`

    ctx.args = { options }

    const span = this.startSpan(this.operationName(), {
      meta: {
        service: this.serviceName({ pluginConfig: this.config }),
        'span.type': 'websocket',
        'http.upgraded': 'websocket',
        'http.method': options.method,
        'http.url': uri,
        'resource.name': `${options.method} ${path}`,
        'span.kind': 'server'

      }

    }, ctx)
    ctx.span = span

    return ctx.currentStore
  }

  bindAsyncStart (ctx) {
    ctx.span.setTag(HTTP_STATUS_CODE, ctx.req.resStatus)

    return ctx.parentStore
  }

  asyncStart (ctx) {
    ctx.socket.spanContext = ctx.span._spanContext

    ctx.span.finish()
  }
}

function getRequestProtocol(req, fallback = 'ws') {
  // 1. Check if the underlying TLS socket has 'encrypted'
  if (req.socket && req.socket.encrypted) {
    return 'wss';
  }

  // 2. Check for a trusted header set by a proxy
  if (req.headers && req.headers['x-forwarded-proto']) {
    const proto = req.headers['x-forwarded-proto'].split(',')[0].trim();
    if (proto === 'https') return 'wss';
    if (proto === 'http') return 'ws';
  }

  // 3. Fallback to ws 
  return fallback;
}


module.exports = WSServerPlugin
