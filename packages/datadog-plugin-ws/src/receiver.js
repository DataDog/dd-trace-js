'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing.js')

class WSReceiverPlugin extends TracingPlugin {
  static get id () { return 'ws' }
  static get prefix () { return 'tracing:ws:receive' }
  static get type () { return 'websocket' }
  static get kind () { return 'consumer' }

  bindStart (ctx) {
    const {
      traceWebsocketMessagesEnabled,
      traceWebsocketMessagesInheritSampling,
      traceWebsocketMessagesSeparateTraces
    } = this.config
    if (!traceWebsocketMessagesEnabled) return

    const { byteLength, socket, binary } = ctx
    const spanTags = socket.spanContext ? socket.spanContext.spanTags : {}
    const path = spanTags['resource.name'] ? spanTags['resource.name'].split(' ')[1] : '/'
    const opCode = binary ? 'binary' : 'text'

    const service = this.serviceName({ pluginConfig: this.config })
    const span = this.startSpan(this.operationName(), {
      service,
      meta: {
        'span.type': 'websocket',
        'span.kind': 'consumer',
        'resource.name': `websocket ${path}`,
        'websocket.duration.style': 'handler',
        'websocket.message.type': opCode,
      },
      metrics: {
        'websocket.message.length': byteLength,
      }

    }, ctx)

    if (traceWebsocketMessagesInheritSampling && traceWebsocketMessagesSeparateTraces) {
      span.setTag('_dd.dm.service', spanTags['service.name'] || service)
      span.setTag('_dd.dm.resource', spanTags['resource.name'] || `websocket ${path}`)
      span.setTag('_dd.dm.inherited', 1)
    }

    ctx.span = span
    return ctx.currentStore
  }

  bindAsyncStart (ctx) {
    return ctx.parentStore
  }

  asyncStart (ctx) {
    ctx.span.finish()
  }

  end (ctx) {
    if (!Object.hasOwn(ctx, 'result')) return

    if (ctx.socket.spanContext) ctx.span.addLink(ctx.socket.spanContext, { 'dd.kind': 'executed_by' })

    ctx.span.finish()
    return ctx.parentStore
  }
}

module.exports = WSReceiverPlugin
