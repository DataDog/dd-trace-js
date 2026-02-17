'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { DsmPathwayCodec, getHeadersSize } = require('../../dd-trace/src/datastreams')
const id = require('../../dd-trace/src/id')

class GoogleCloudPubsubProducerPlugin extends ProducerPlugin {
  static id = 'google-cloud-pubsub'
  static operation = 'request'

  constructor (...args) {
    super(...args)

    /**
     * Inject trace context into individual messages published via Topic.publish() or
     * Topic.publishMessage(). This happens before the batch publish API call, allowing
     * each message to propagate trace context to consumers.
     */
    this.addSub('apm:google-cloud-pubsub:message:publish', this.handleMessagePublish.bind(this))
  }

  handleMessagePublish ({ attributes, pubsub, topicName }) {
    // Skip if message already has trace context from upstream
    if (attributes['x-datadog-trace-id'] || attributes.traceparent) return

    const activeSpan = this.tracer.scope().active()
    if (!activeSpan) return

    // Inject current span's trace context into message attributes
    this.tracer.inject(activeSpan, 'text_map', attributes)

    const traceIdUpperBits = activeSpan.context()._trace.tags['_dd.p.tid']
    if (traceIdUpperBits) attributes['_dd.p.tid'] = traceIdUpperBits

    if (pubsub) attributes['gcloud.project_id'] = pubsub.projectId
    if (topicName) attributes['pubsub.topic'] = topicName
  }

  start (ctx) {
    if (!this.config.dsmEnabled) return
    const { request } = ctx
    const messages = request.messages || []
    const topic = request.topic
    const { span } = ctx.currentStore

    for (const msg of messages) {
      const dataStreamsContext = this.tracer.setCheckpoint(
        ['direction:out', `topic:${topic}`, 'type:google-pubsub'],
        span,
        getHeadersSize(msg)
      )
      DsmPathwayCodec.encode(dataStreamsContext, msg.attributes)
    }
  }

  bindStart (ctx) {
    const { request, api, projectId } = ctx
    if (api !== 'publish') return

    const messages = request.messages || []
    const topic = request.topic
    const messageCount = messages.length
    const hasTraceContext = messages[0]?.attributes?.['x-datadog-trace-id']

    /**
     * Batch Publishing Strategy:
     * - Create one "batch span" representing the entire publish operation
     * - If messages already have trace context (from upstream), use the first message's
     *   context as the parent, and create span links for messages 2-N
     * - Otherwise, use the current active span as parent
     * - Inject batch span context + metadata into all message attributes for downstream
     *   consumers to reconstruct the trace and understand batch relationships
     */
    const spanLinkData = hasTraceContext
      ? messages.slice(1).map(msg => this.#extractSpanLink(msg.attributes)).filter(Boolean)
      : []

    const firstAttrs = messages[0]?.attributes
    const parentData = firstAttrs?.['x-datadog-trace-id'] && firstAttrs['x-datadog-parent-id']
      ? {
          traceId: firstAttrs['x-datadog-trace-id'],
          spanId: firstAttrs['x-datadog-parent-id'],
          traceIdUpper: firstAttrs['_dd.p.tid'],
          samplingPriority: firstAttrs['x-datadog-sampling-priority'],
        }
      : null

    const lastSlash = topic.lastIndexOf('/')
    const topicName = lastSlash === -1 ? topic : topic.slice(lastSlash + 1)
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
        operation: messageCount > 1 ? 'batched.pubsub.request' : 'pubsub.request',
      },
      metrics: {
        'pubsub.batch.message_count': messageCount,
        'pubsub.batch': messageCount > 1 ? true : undefined,
      },
    }, ctx)

    const spanCtx = batchSpan.context()
    // Get 128-bit trace ID and span ID as hex strings
    const fullTraceIdHex = spanCtx.toTraceId(true)
    const batchSpanIdHex = spanCtx.toSpanId(true)
    // Extract lower 64 bits (last 16 hex chars) for trace ID
    const batchTraceIdHex = fullTraceIdHex.slice(-16)
    const batchTraceIdUpper = spanCtx._trace.tags['_dd.p.tid']

    if (spanLinkData.length) {
      batchSpan.setTag('_dd.span_links', JSON.stringify(
        spanLinkData.map(link => ({
          trace_id: link.traceId,
          span_id: link.spanId,
          flags: link.samplingPriority || 0,
        }))
      ))
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      msg.attributes ??= {}

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
        'x-dd-publish-start-time': String(Math.floor(batchSpan._startTime)),
      })

      if (batchTraceIdUpper) {
        msg.attributes['_dd.pubsub_request.p.tid'] = batchTraceIdUpper
      }

    }

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
    }
    return ctx.parentStore
  }

  #extractSpanLink (attrs) {
    if (!attrs?.['x-datadog-trace-id'] || !attrs['x-datadog-parent-id']) return null

    // Convert to hex strings
    const lowerHex = id(attrs['x-datadog-trace-id']).toString(16)
    const spanIdHex = id(attrs['x-datadog-parent-id']).toString(16)

    // Build full 128-bit trace ID
    const traceIdHex = attrs['_dd.p.tid']
      ? attrs['_dd.p.tid'] + lowerHex
      : lowerHex.padStart(32, '0')

    return {
      traceId: traceIdHex,
      spanId: spanIdHex,
      samplingPriority: attrs['x-datadog-sampling-priority']
        ? Number.parseInt(attrs['x-datadog-sampling-priority'], 10)
        : undefined,
    }
  }

  #extractParentContext (data) {
    const carrier = {
      'x-datadog-trace-id': data.traceId,
      'x-datadog-parent-id': data.spanId,
    }
    if (data.traceIdUpper) carrier['_dd.p.tid'] = data.traceIdUpper
    if (data.samplingPriority) carrier['x-datadog-sampling-priority'] = String(data.samplingPriority)

    return this.tracer.extract('text_map', carrier)
  }
}

module.exports = GoogleCloudPubsubProducerPlugin
