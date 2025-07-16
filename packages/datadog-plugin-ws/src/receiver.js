'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing.js')

class WSReceiverPlugin extends TracingPlugin {
  static get id () { return 'ws' }
  static get prefix () { return 'tracing:ws:receive' }
  static get type () { return 'websocket' }
  static get kind () { return 'receiver' }

  bindStart (ctx) {

    // console.log('ctx.socket.spanContext', ctx.binary)
    const opCode = ctx.binary ? 'binary' : 'text'
    
    // console.log('receiving', opCode, ctx.byteLength)
    const span = this.startSpan(this.operationName(), {
      meta: {
        service: this.serviceName({ pluginConfig: this.config }),
        // 'resource.name': `websocket ${path}`,
        'span.type': 'websocket',
        'span.kind': 'consumer',
        'dd.kind': 'executed_by'
      },
      metrics: {
        'websocket.message.type': opCode,
        'websocket.message.length': ctx.byteLength,
        // 'websocket.message.frames':
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
    // console.log('async start in recevier')
    ctx.span.finish()
    return ctx.parentStore
  }

  bindFinish (ctx) {
    // console.log('bind finish?')
    return ctx.parentStore
  }

  end (ctx) {
    // console.log('end in receiver')
    if (!Object.hasOwn(ctx, 'result')) return

    ctx.span.addLink(ctx.socket.spanContext)

    ctx.span.finish()
    return ctx.parentStore
  }
}

module.exports = WSReceiverPlugin
