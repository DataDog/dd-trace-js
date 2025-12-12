'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { DsmPathwayCodec, getHeadersSize } = require('../../dd-trace/src/datastreams')
const log = require('../../dd-trace/src/log')

class GoogleCloudPubsubProducerPlugin extends ProducerPlugin {
  static id = 'google-cloud-pubsub'
  static operation = 'request'

  constructor (...args) {
    super(...args)

    // Subscribe to message publish events for trace context injection
    this.addSub('apm:google-cloud-pubsub:message:publish', this.handleMessagePublish.bind(this))
  }

  handleMessagePublish ({ attributes, pubsub, topicName }) {
    // Don't inject if already has trace context
    if (attributes['x-datadog-trace-id'] || attributes.traceparent) return

    try {
      const activeSpan = this.tracer.scope().active()
      if (!activeSpan) return

      // Inject trace context into message attributes
      this.tracer.inject(activeSpan, 'text_map', attributes)

      // Add 128-bit trace ID upper bits if present
      const traceIdUpperBits = activeSpan.context()._trace.tags['_dd.p.tid']
      if (traceIdUpperBits) attributes['_dd.p.tid'] = traceIdUpperBits

      // Add metadata
      if (pubsub) attributes['gcloud.project_id'] = pubsub.projectId
      if (topicName) attributes['pubsub.topic'] = topicName
    } catch (err) {
      // Silently fail - trace context injection is best-effort
      log.warn(`Error injecting trace context into message attributes: ${err.message}`)
    }
  }

  bindStart (ctx) {
    const { request, api, projectId } = ctx
    if (api !== 'publish') return

    const messages = request.messages || []
    const topic = request.topic
    const messageCount = messages.length
    const hasTraceContext = messages[0]?.attributes?.['x-datadog-trace-id']

    // Collect span links from messages 2-N (skip first - it becomes parent)
    const spanLinkData = hasTraceContext
      ? messages.slice(1).map(msg => this.#extractSpanLink(msg.attributes)).filter(Boolean)
      : []

    const firstAttrs = messages[0]?.attributes
    const parentData = firstAttrs?.['x-datadog-trace-id'] && firstAttrs['x-datadog-parent-id']
      ? {
          traceId: firstAttrs['x-datadog-trace-id'],
          spanId: firstAttrs['x-datadog-parent-id'],
          traceIdUpper: firstAttrs['_dd.p.tid'],
          samplingPriority: firstAttrs['x-datadog-sampling-priority']
        }
      : null

    const topicName = topic.split('/').pop() || topic
    const batchSpan = this.startSpan({
      childOf: parentData ? this.#extractParentContext(parentData) : undefined,
      resource: `${api} to Topic ${topicName}`,
      meta: {
        'gcloud.project_id': projectId,
        'pubsub.method': api,
        'pubsub.topic': topic,
        'span.kind': 'producer',
        '_dd.base_service': this.tracer._service,
        '_dd.serviceoverride.type': 'integration',
        'pubsub.linked_message_count': spanLinkData.length || undefined,
        operation: messageCount > 1 ? 'batched.pubsub.request' : 'pubsub.request'
      },
      metrics: {
        'pubsub.batch.message_count': messageCount,
        'pubsub.batch': messageCount > 1 ? true : undefined
      }
    }, ctx)

    const spanCtx = batchSpan.context()
    const batchTraceId = spanCtx.toTraceId()
    const batchSpanId = spanCtx.toSpanId()
    const batchTraceIdUpper = spanCtx._trace.tags['_dd.p.tid']
    const batchTraceIdHex = BigInt(batchTraceId).toString(16).padStart(16, '0')
    const batchSpanIdHex = BigInt(batchSpanId).toString(16).padStart(16, '0')

    if (spanLinkData.length) {
      batchSpan.setTag('_dd.span_links', JSON.stringify(
        spanLinkData.map(link => ({
          trace_id: link.traceId,
          span_id: link.spanId,
          flags: link.samplingPriority || 0
        }))
      ))
    }

    messages.forEach((msg, i) => {
      msg.attributes = msg.attributes || {}

      if (!hasTraceContext) {
        this.tracer.inject(batchSpan, 'text_map', msg.attributes)
      }

      Object.assign(msg.attributes, {
        '_dd.pubsub_request.trace_id': batchTraceIdHex,
        '_dd.pubsub_request.span_id': batchSpanIdHex,
        '_dd.batch.size': String(messageCount),
        '_dd.batch.index': String(i),
        'gcloud.project_id': projectId,
        'pubsub.topic': topic,
        'x-dd-publish-start-time': String(Math.floor(batchSpan._startTime))
      })

      if (batchTraceIdUpper) {
        msg.attributes['_dd.pubsub_request.p.tid'] = batchTraceIdUpper
      }

      if (this.config.dsmEnabled) {
        const dataStreamsContext = this.tracer.setCheckpoint(
          ['direction:out', `topic:${topic}`, 'type:google-pubsub'],
          batchSpan,
          getHeadersSize(msg)
        )
        DsmPathwayCodec.encode(dataStreamsContext, msg.attributes)
      }
    })

    ctx.batchSpan = batchSpan
    return ctx.currentStore
  }

  bindFinish (ctx) {
    if (ctx.batchSpan && !ctx.batchSpan._duration) ctx.batchSpan.finish()
    return super.bindFinish(ctx)
  }

  bindError (ctx) {
    if (ctx.error && ctx.batchSpan) {
      ctx.batchSpan.setTag('error', ctx.error)
      ctx.batchSpan.finish()
    }
    return ctx.parentStore
  }

  #extractSpanLink (attrs) {
    if (!attrs?.['x-datadog-trace-id'] || !attrs['x-datadog-parent-id']) return null

    const lowerHex = BigInt(attrs['x-datadog-trace-id']).toString(16).padStart(16, '0')
    const spanIdHex = BigInt(attrs['x-datadog-parent-id']).toString(16).padStart(16, '0')
    const traceIdHex = attrs['_dd.p.tid']
      ? attrs['_dd.p.tid'] + lowerHex
      : lowerHex.padStart(32, '0')

    return {
      traceId: traceIdHex,
      spanId: spanIdHex,
      samplingPriority: attrs['x-datadog-sampling-priority']
        ? Number.parseInt(attrs['x-datadog-sampling-priority'], 10)
        : undefined
    }
  }

  #extractParentContext (data) {
    const carrier = {
      'x-datadog-trace-id': data.traceId,
      'x-datadog-parent-id': data.spanId
    }
    if (data.traceIdUpper) carrier['_dd.p.tid'] = data.traceIdUpper
    if (data.samplingPriority) carrier['x-datadog-sampling-priority'] = String(data.samplingPriority)

    return this.tracer.extract('text_map', carrier)
  }
}

module.exports = GoogleCloudPubsubProducerPlugin
