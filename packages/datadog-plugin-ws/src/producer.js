'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing.js')

class WSProducerPlugin extends TracingPlugin {
  static get id () { return 'websocket' }
  static get prefix () { return 'tracing:ws:send' }
  static get type () { return 'websocket' }
  static get kind () { return 'producer' }

  bindStart (ctx) {
    const span = this.startSpan(this.operationName(), {
      meta: {
        service: this.serviceName({ pluginConfig: this.config }),
        // 'resource.name': 'websocket ' + ,
        'span.type': 'ws',
        'span.kind': 'producer'

      }

    }, ctx)

    ctx.span = span

    return ctx.currentStore
  }

  bindAsyncStart (ctx) {
    return ctx.parentStore
  }

  asyncStart (ctx) {
    ctx.span.addLink(ctx.link.spanContext)

    ctx.span.finish()
  }

  end (ctx) {
    if (!Object.hasOwn(ctx, 'result')) return

    ctx.span.addLink(ctx.socket.spanContext)

    ctx.span.finish()
  }
}

module.exports = WSProducerPlugin
