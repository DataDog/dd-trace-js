'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { DsmPathwayCodec, getSizeOrZero } = require('../../dd-trace/src/datastreams')

class BaseNatsProducerPlugin extends ProducerPlugin {
  static id = 'nats'
  static prefix = 'tracing:orchestrion:nats:publish'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    const span = this.startSpan({
      meta,
    }, ctx)

    this._setProducerCheckpoint(span, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    return {
      component: 'nats',
      'span.kind': 'producer',
      'messaging.system': 'nats',
      'messaging.destination.name': ctx.arguments?.[0],
      'messaging.operation': 'send',
    }
  }

  /**
   * Sets a DSM checkpoint for a produce operation, encoding pathway context into NATS headers.
   * @param {import('../../dd-trace/src/opentracing/span')} span
   * @param {object} ctx
   */
  _setProducerCheckpoint (span, ctx) {
    if (!this.config.dsmEnabled) return

    const subject = ctx.arguments?.[0]
    const data = ctx.arguments?.[1]
    const options = ctx.arguments?.[2]

    const payloadSize = getSizeOrZero(data)
    const edgeTags = ['direction:out', `topic:${subject}`, 'type:nats']
    const dataStreamsContext = this.tracer.setCheckpoint(edgeTags, span, payloadSize)

    // Encode pathway context into NATS message headers if they exist and support set()
    if (options?.headers && typeof options.headers.set === 'function') {
      const carrier = {}
      DsmPathwayCodec.encode(dataStreamsContext, carrier)
      const pathwayCtx = carrier['dd-pathway-ctx-base64']
      if (pathwayCtx) {
        options.headers.set('dd-pathway-ctx-base64', pathwayCtx)
      }
    }
  }

  // asyncEnd and end delegate to finish() which has the required guard
  asyncEnd (ctx) {
    this.finish(ctx)
  }

  end (ctx) {
    this.finish(ctx)
  }

  // You may modify this method, but the guard below is REQUIRED and MUST NOT be removed!
  finish (ctx) {
    // CRITICAL GUARD - DO NOT REMOVE: Ensures span only finishes when operation completes
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }
}

class RequestPlugin extends BaseNatsProducerPlugin {
  static prefix = 'tracing:orchestrion:nats:request'
}

module.exports = {
  BaseNatsProducerPlugin,
  RequestPlugin,
}
