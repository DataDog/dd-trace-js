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

    const agent = options.agent || options._defaultAgent || http.globalAgent || {}
    const protocol = options.protocol || agent.protocol || 'http:'
    const hostname = options.hostname || options.host || 'localhost'
    const host = options.port ? `${hostname}:${options.port}` : hostname
    const pathname = options.path || options.pathname
    const path = pathname ? pathname.split(/[?#]/)[0] : '/'
    const uri = `${protocol}//${host}${path}`

    ctx.args = { options }

    const span = this.startSpan(this.operationName(), {
      meta: {
        service: this.serviceName({ pluginConfig: this.config }),
        'span.type': 'ws',
        'http.upgraded': 'websocket',
        'http.method': options.method,
        'http.url': uri,
        'resource.name': options.method,
        'span.kind': 'server'

      }

    }, ctx)
    ctx.span = span

    return ctx.currentStore
  }

  bindAsyncStart (ctx) {
    console.log('in server bind async ')
    ctx.span.setTag(HTTP_STATUS_CODE, ctx.req.resStatus)

    return ctx.parentStore
  }

  asyncStart (ctx) {
    console.log('in server async ')
    ctx.socket.spanContext = ctx.span._spanContext

    ctx.span.finish()
  }
}

module.exports = WSServerPlugin
