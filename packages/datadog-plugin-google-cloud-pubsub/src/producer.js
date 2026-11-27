'use strict'

const {
  readDatadogParentId,
  readDatadogSamplingPriority,
  readDatadogTraceId,
  readTraceparent,
} = require('../../dd-trace/src/carrier')
const { DsmPathwayCodec, getHeadersSize } = require('../../dd-trace/src/datastreams')
const id = require('../../dd-trace/src/id')
const SpanContext = require('../../dd-trace/src/opentracing/span_context')
const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { getTopicName } = require('./resource-names')

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
    // Skip if propagation is disabled or the message already has trace context from upstream
    if (
      !this._tracerConfig.DD_TRACE_GOOGLE_CLOUD_PUBSUB_PROPAGATION_ENABLED ||
      readDatadogTraceId(attributes) ||
      readTraceparent(attributes)
    ) return

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
    if (!this.config.dsmEnabled || ctx.api !== 'publish' || !ctx.currentStore) return
    const { request } = ctx
    const messages = request.messages || []
    const topic = request.topic
    const { span } = ctx.currentStore

    for (const msg of messages) {
      const attributes = msg.attributes ??= {}
      const dataStreamsContext = this.tracer.setCheckpoint(
        ['direction:out', `topic:${topic}`, 'type:google-pubsub'],
        span,
        getHeadersSize(msg)
      )
      DsmPathwayCodec.encode(dataStreamsContext, attributes)
    }
  }

  bindStart (ctx) {
    const { request, api, projectId } = ctx
    if (api !== 'publish') return

    const messages = request.messages || []
    const topic = request.topic
    const messageCount = messages.length
    const propagationEnabled = this._tracerConfig.DD_TRACE_GOOGLE_CLOUD_PUBSUB_PROPAGATION_ENABLED
    // With propagation disabled, Datadog context already present in the attributes is ignored, so the batch span
    // stays a child of the active span and no trace context is written into the messages.
    const hasTraceContext = propagationEnabled && messages[0]?.attributes &&
      readDatadogTraceId(messages[0].attributes)
    const parentContext = hasTraceContext && readDatadogParentId(messages[0].attributes)
      ? this.tracer.extract('text_map', messages[0].attributes)
      : undefined

    /**
     * Batch Publishing Strategy:
     * - Create one "batch span" representing the entire publish operation
     * - If messages already have trace context (from upstream), use the first message's
     *   context as the parent, and create span links for messages 2-N
     * - Otherwise, use the current active span as parent
     * - Inject batch span context + metadata into all message attributes for downstream
     *   consumers to reconstruct the trace and understand batch relationships
     */
    const spanLinks = []
    if (hasTraceContext) {
      for (let i = 1; i < messageCount; i++) {
        const link = this.#extractSpanLink(messages[i].attributes)
        if (link) spanLinks.push(link)
      }
    }

    const lastSlash = topic.lastIndexOf('/')
    const topicName = lastSlash === -1 ? topic : topic.slice(lastSlash + 1)
    const batchSpan = this.startSpan({
      childOf: parentContext,
      resource: `${api} to Topic ${topicName}`,
      meta: {
        'gcloud.project_id': projectId,
        'pubsub.method': api,
        'pubsub.topic': topic,
        'span.kind': 'producer',
        '_dd.base_service': this.tracer._service,
        '_dd.serviceoverride.type': 'integration',
        'pubsub.linked_message_count': spanLinks.length || undefined,
        operation: messageCount > 1 ? 'batched.pubsub.request' : 'pubsub.request',
        'gcp.pubsub.topic.name': getTopicName(topic),
      },
      metrics: {
        'pubsub.batch.message_count': messageCount,
        'pubsub.batch': messageCount > 1 ? true : undefined,
      },
    }, ctx)

    let batchTraceIdHex
    let batchSpanIdHex
    let batchTraceIdUpper
    if (propagationEnabled) {
      const spanCtx = batchSpan.context()
      // Extract lower 64 bits (last 16 hex chars) of the 128-bit trace ID
      batchTraceIdHex = spanCtx.toTraceId(true).slice(-16)
      batchSpanIdHex = spanCtx.toSpanId(true)
      batchTraceIdUpper = spanCtx._trace.tags['_dd.p.tid']
    }

    if (spanLinks.length) batchSpan.addLinks(spanLinks)

    const messageCountStr = String(messageCount)
    const startTimeStr = String(Math.floor(batchSpan._startTime))

    for (let i = 0; i < messageCount; i++) {
      const msg = messages[i]
      const attributes = msg.attributes ??= {}

      if (propagationEnabled) {
        if (!hasTraceContext) {
          this.tracer.inject(batchSpan, 'text_map', attributes)
        }

        attributes['_dd.pubsub_request.trace_id'] = batchTraceIdHex
        attributes['_dd.pubsub_request.span_id'] = batchSpanIdHex
      }

      // Assign keys one-by-one rather than via `Object.assign({...})` so V8
      // keeps the attributes object on its existing hidden class instead of
      // allocating a fresh literal per message.
      attributes['_dd.batch.size'] = messageCountStr
      attributes['_dd.batch.index'] = String(i)
      attributes['gcloud.project_id'] = projectId
      attributes['pubsub.topic'] = topic
      attributes['x-dd-publish-start-time'] = startTimeStr

      if (batchTraceIdUpper) {
        attributes['_dd.pubsub_request.p.tid'] = batchTraceIdUpper
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
    if (!attrs) return null
    const traceId = readDatadogTraceId(attrs)
    const spanId = readDatadogParentId(attrs)
    if (!traceId || !spanId) return null

    const samplingPriority = readDatadogSamplingPriority(attrs)
    return {
      context: new SpanContext({
        traceId: id(traceId, 10),
        spanId: id(spanId, 10),
        sampling: { priority: samplingPriority ? Number.parseInt(samplingPriority, 10) : 0 },
        trace: {
          started: [],
          finished: [],
          tags: attrs['_dd.p.tid'] ? { '_dd.p.tid': attrs['_dd.p.tid'] } : {},
        },
      }),
    }
  }
}

module.exports = GoogleCloudPubsubProducerPlugin
