'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing.js')
const {
  WEBSOCKET_PTR_KIND,
  SPAN_POINTER_DIRECTION,
  SPAN_POINTER_DIRECTION_NAME
} = require('../../dd-trace/src/constants')
const {
  incrementWebSocketCounter,
  buildWebSocketSpanPointerHash,
  hasDistributedTracingContext
} = require('./util')

class WSReceiverPlugin extends TracingPlugin {
  static get id () { return 'ws' }
  static get prefix () { return 'tracing:ws:receive' }
  static get type () { return 'websocket' }
  static get kind () { return 'consumer' }

  bindStart (ctx) {
    const {
      traceWebsocketMessagesInheritSampling,
      traceWebsocketMessagesSeparateTraces
    } = this.config

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
    if (!Object.hasOwn(ctx, 'result') || !ctx.span) return

    if (ctx.socket.spanContext) {
      const linkAttributes = { 'dd.kind': 'executed_by' }

      // Add span pointer for context propagation
      if (this.config.traceWebsocketMessagesEnabled && ctx.socket.handshakeSpan) {
        const handshakeSpan = ctx.socket.handshakeSpan

        // Only add span pointers if distributed tracing is enabled and handshake has distributed context
        if (hasDistributedTracingContext(handshakeSpan, ctx.socket)) {
          const counter = incrementWebSocketCounter(ctx.socket, 'receiveCounter')
          const handshakeContext = handshakeSpan.context()

          const ptrHash = buildWebSocketSpanPointerHash(
            handshakeContext._traceId,
            handshakeContext._spanId,
            counter,
            true, // isServer
            true // isIncoming
          )

          // Add span pointer attributes to link
          linkAttributes['link.name'] = SPAN_POINTER_DIRECTION_NAME.UPSTREAM
          linkAttributes['dd.kind'] = 'span-pointer'
          linkAttributes['ptr.kind'] = WEBSOCKET_PTR_KIND
          linkAttributes['ptr.dir'] = SPAN_POINTER_DIRECTION.UPSTREAM
          linkAttributes['ptr.hash'] = ptrHash
        }
      }

      ctx.span.addLink({
        context: ctx.socket.spanContext,
        attributes: linkAttributes,
      })
    }

    ctx.span.finish()
    return ctx.parentStore
  }
}

module.exports = WSReceiverPlugin
