'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing.js')

class WSProducerPlugin extends TracingPlugin {
  static get id () { return 'ws' }
  static get prefix () { return 'tracing:ws:send' }
  static get type () { return 'websocket' }
  static get kind () { return 'producer' }

  bindStart (ctx) {
    const messagesEnabled = this.config.traceWebsocketMessagesEnabled
    if (!messagesEnabled) return

    const { byteLength, socket, binary } = ctx
    if (!socket.spanContext) return

    const spanTags = socket.spanContext.spanTags
    const path = spanTags['resource.name'].split(' ')[1]
    const opCode = binary ? 'binary' : 'text'
    const service = this.serviceName({ pluginConfig: this.config })
    const span = this.startSpan(this.operationName(), {
      service,
      meta: {
        'span.type': 'websocket',
        'span.kind': 'producer',
        'resource.name': `websocket ${path}`,
        'websocket.message.type': opCode,

      },
      metrics: {
        'websocket.message.length': byteLength
      }

    }, ctx)

    ctx.span = span
    return ctx.currentStore
  }

  bindAsyncStart (ctx) {
    ctx.span.finish()
    return ctx.parentStore
  }

  asyncStart (ctx) {
    ctx.span.finish()
  }

  end (ctx) {
    if (!Object.hasOwn(ctx, 'result')) return

    if (ctx.socket.spanContext) {
      ctx.span.addLink({
        context: ctx.socket.spanContext,
        attributes: { 'dd.kind': 'resuming' },
      })
    }

    ctx.span.finish()
    return ctx.parentStore
  }
}

module.exports = WSProducerPlugin
