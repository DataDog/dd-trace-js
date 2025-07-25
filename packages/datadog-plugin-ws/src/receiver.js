'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing.js')

class WSReceiverPlugin extends TracingPlugin {
  static get id () { return 'websocket' }
  static get prefix () { return 'tracing:ws:receive' }
  static get type () { return 'websocket' }
  static get kind () { return 'consumer' }

  bindStart (ctx) {
    const { spanTags } = ctx.socket.spanContext
    const path = spanTags['resource.name'].split(' ')[1]
    const opCode = ctx.binary ? 'binary' : 'text'

    const span = this.startSpan(this.operationName(), {
      meta: {
        service: this.serviceName({ pluginConfig: this.config }),
        'span.type': 'websocket',
        'span.kind': 'consumer',
        'resource.name': `websocket ${path}`,
        'dd.kind': 'executed_by',
      },
      metrics: {
        'websocket.message.type': opCode,
        'websocket.message.length': ctx.byteLength,
        '_dd.dm.inherited': 1,
        '_dd.dm.service': spanTags['service.name'],
        '_dd.dm.resource': spanTags['resource.name']
      }

    }, ctx)

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

    ctx.span.addLink(ctx.socket.spanContext)

    ctx.span.finish()
    return ctx.parentStore
  }
}

module.exports = WSReceiverPlugin
