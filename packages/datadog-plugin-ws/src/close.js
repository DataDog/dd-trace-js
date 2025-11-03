'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing.js')

class WSClosePlugin extends TracingPlugin {
  static get id () { return 'ws' }
  static get prefix () { return 'tracing:ws:close' }
  static get type () { return 'websocket' }
  static get kind () { return 'close' }

  bindStart (ctx) {
    const {
      traceWebsocketMessagesEnabled,
      traceWebsocketMessagesInheritSampling,
      traceWebsocketMessagesSeparateTraces
    } = this.config
    if (!traceWebsocketMessagesEnabled) return

    const { code, data, socket, isPeerClose } = ctx
    if (!socket?.spanContext) return

    const spanKind = isPeerClose ? 'consumer' : 'producer'
    const spanTags = socket.spanContext.spanTags
    const path = spanTags['resource.name'].split(' ')[1]
    const service = this.serviceName({ pluginConfig: this.config })
    const span = this.startSpan(this.operationName(), {
      service,
      meta: {
        'resource.name': `websocket ${path}`,
        'span.type': 'websocket',
        'span.kind': spanKind,
        'websocket.close.code': code

      }
    }, ctx)

    if (data?.toString().length > 0) {
      span.setTag('websocket.close.reason', data.toString())
    }

    if (isPeerClose && traceWebsocketMessagesInheritSampling && traceWebsocketMessagesSeparateTraces) {
      span.setTag('_dd.dm.service', spanTags['service.name'] || service)
      span.setTag('_dd.dm.resource', spanTags['resource.name'] || `websocket ${path}`)
      span.setTag('_dd.dm.inherited', 1)
    }

    ctx.span = span
    return ctx.currentStore
  }

  bindAsyncStart (ctx) {
    if (!ctx.isPeerClose) ctx.span.finish()
    return ctx.parentStore
  }

  asyncStart (ctx) {
    ctx.span.finish()
  }

  end (ctx) {
    if (!Object.hasOwn(ctx, 'result') || !ctx.span) return

    if (ctx.socket.spanContext) ctx.span.addLink({ context: ctx.socket.spanContext })

    ctx.span.finish()
  }
}

module.exports = WSClosePlugin
