'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing.js')
const {
  incrementWebSocketCounter,
  buildWebSocketSpanPointerHash,
  hasDistributedTracingContext
} = require('./util')
const {
  WEBSOCKET_PTR_KIND,
  SPAN_POINTER_DIRECTION,
  SPAN_POINTER_DIRECTION_NAME
} = require('../../dd-trace/src/constants')

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

    if (ctx.socket.spanContext) {
      const linkAttributes = {}

      // Determine link kind based on whether this is peer close (incoming) or self close (outgoing)
      const isIncoming = ctx.isPeerClose
      linkAttributes['dd.kind'] = isIncoming ? 'executed_by' : 'resuming'

      // Add span pointer for context propagation
      if (this.config.traceWebsocketMessagesEnabled && ctx.socket.handshakeSpan) {
        const handshakeSpan = ctx.socket.handshakeSpan

        // Only add span pointers if distributed tracing is enabled and handshake has distributed context
        if (hasDistributedTracingContext(handshakeSpan)) {
          const counterType = isIncoming ? 'receiveCounter' : 'sendCounter'
          const counter = incrementWebSocketCounter(ctx.socket, counterType)
          const handshakeContext = handshakeSpan.context()

          const ptrHash = buildWebSocketSpanPointerHash(
            handshakeContext._traceId.toString(16),
            handshakeContext._spanId.toString(16),
            counter,
            true, // isServer
            isIncoming
          )

          const directionName = isIncoming
            ? SPAN_POINTER_DIRECTION_NAME.UPSTREAM
            : SPAN_POINTER_DIRECTION_NAME.DOWNSTREAM
          const direction = isIncoming
            ? SPAN_POINTER_DIRECTION.UPSTREAM
            : SPAN_POINTER_DIRECTION.DOWNSTREAM

          // Add span pointer attributes to link
          linkAttributes['link.name'] = directionName
          linkAttributes['dd.kind'] = 'span-pointer'
          linkAttributes['ptr.kind'] = WEBSOCKET_PTR_KIND
          linkAttributes['ptr.dir'] = direction
          linkAttributes['ptr.hash'] = ptrHash
        }
      }

      ctx.span.addLink({
        context: ctx.socket.spanContext,
        attributes: linkAttributes
      })
    }

    ctx.span.finish()
  }
}

module.exports = WSClosePlugin
