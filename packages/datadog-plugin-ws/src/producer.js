'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing.js')

class WSProducerPlugin extends TracingPlugin {
  static get id () { return 'ws' }
  static get prefix () { return 'tracing:ws:send' }
  static get type () { return 'websocket' }
  static get kind () { return 'producer' }

  bindStart (ctx) {
    const span = this.startSpan(this.operationName(), {
      meta: {
        service: this.serviceName({ pluginConfig: this.config }),
        'resource.name': 'websocket.send',
        'span.type': 'websocket',
        'span.kind': 'producer'

      }

    }, ctx)

    ctx.span = span

    return ctx.currentStore
  }

  bindAsyncStart (ctx) {
    // console.log('bind asyc start in producer')
    ctx.span.finish()
    return ctx.parentStore
  }

  asyncStart (ctx) {
    // console.log(' asyc start in producer')
    ctx.span.addLink(ctx.link.spanContext)

    ctx.span.finish()
  }

  end (ctx) {
    // console.log('end start in producer')
    // if (!Object.hasOwn(ctx, 'result')) return

    ctx.span.addLink(ctx.socket.spanContext)

    ctx.span.finish()
    return ctx.parentStore
  }
}

module.exports = WSProducerPlugin
