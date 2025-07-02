'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing.js')

class WSReceiverPlugin extends TracingPlugin {
  static get id () { return 'websocket' }
  static get prefix () { return 'tracing:ws:receive' }
  static get type () { return 'websocket' }
  static get kind () { return 'receiver' }

  bindStart (ctx) {
    const span = this.startSpan(this.operationName(), {
      meta: {
        service: this.serviceName({ pluginConfig: this.config }),
        'resource.name': 'websocket.receive',
        'span.type': 'ws',
        'span.kind': 'receiver'

      }

    }, ctx)

    ctx.span = span

    return ctx.currentStore
  }

  bindAsyncStart (ctx) {
    console.log('bind async start in receiver')
    return ctx.parentStore
  }

  asyncStart (ctx) {
    console.log('async start in recevier')
    ctx.span.finish()
    return ctx.parentStore
  }

  bindFinish (ctx) {
    console.log('bind finish?')
    return ctx.parentStore
  }

  end (ctx) {
    console.log('end in receiver')
    if (!Object.hasOwn(ctx, 'result')) return

    ctx.span.addLink(ctx.socket.spanContext)

    ctx.span.finish()
    return ctx.parentStore
  }
}

module.exports = WSReceiverPlugin
