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
const log = require('../../dd-trace/src/log')

class WSReceiverPlugin extends TracingPlugin {
  static get id () { return 'ws' }
  static get prefix () { return 'tracing:ws:receive' }
  static get type () { return 'websocket' }
  static get kind () { return 'consumer' }

  bindStart (ctx) {
    log.debug('[WS-RECEIVER] bindStart called')

    const {
      traceWebsocketMessagesEnabled,
      traceWebsocketMessagesInheritSampling,
      traceWebsocketMessagesSeparateTraces
    } = this.config
    if (!traceWebsocketMessagesEnabled) {
      log.debug('[WS-RECEIVER] bindStart: messages not enabled, returning early')
      return
    }

    const { byteLength, socket, binary } = ctx
    if (!socket.spanContext) {
      log.warn('[WS-RECEIVER] bindStart: socket.spanContext is missing! Socket may not have completed handshake.')
      return
    }

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
    const spanId = ctx.span?._spanContext?._spanId?.toString()
    log.debug('[WS-RECEIVER] bindStart: span created, spanId: %s, path: %s, byteLength: %d', spanId, path, byteLength)
    return ctx.currentStore
  }

  bindAsyncStart (ctx) {
    const spanId = ctx.span?._spanContext?._spanId?.toString()
    log.debug('[WS-RECEIVER] bindAsyncStart called, spanId: %s', spanId)

    if (!ctx.span) {
      log.warn('[WS-RECEIVER] bindAsyncStart: ctx.span is undefined!')
    }
    return ctx.parentStore
  }

  asyncStart (ctx) {
    const spanId = ctx.span?._spanContext?._spanId?.toString()
    log.debug('[WS-RECEIVER] asyncStart called, spanId: %s', spanId)

    if (!ctx.span) {
      log.warn('[WS-RECEIVER] asyncStart: ctx.span is undefined!')
      return
    }
    ctx.span.finish()
    log.debug('[WS-RECEIVER] asyncStart: span finished, spanId: %s', spanId)
  }

  end (ctx) {
    const spanId = ctx.span?._spanContext?._spanId?.toString()
    log.debug('[WS-RECEIVER] end called, spanId: %s, hasResult: %s', spanId, Object.hasOwn(ctx, 'result'))

    if (!Object.hasOwn(ctx, 'result') || !ctx.span) {
      log.debug('[WS-RECEIVER] end: returning early, no result or no span')
      return
    }

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
    log.debug('[WS-RECEIVER] end: span finished, spanId: %s', spanId)
    return ctx.parentStore
  }
}

module.exports = WSReceiverPlugin
