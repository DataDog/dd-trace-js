'use strict'

const { getMessageSize } = require('../../dd-trace/src/datastreams')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const SpanContext = require('../../dd-trace/src/opentracing/span_context')
const id = require('../../dd-trace/src/id')
const { storage } = require('../../datadog-core')

/**
 * PULL SUBSCRIPTION: Service explicitly pulls messages from Pub/Sub and processes them.
 * Async context storage for linking acknowledge() API calls back to original message spans.
 *
 * Problem: message.ack() is often called asynchronously outside the original handler,
 * losing async context. The acknowledge() API only receives ackIds (strings), not Messages.
 *
 * Solution: Store context by Message (WeakMap), lookup by ackId (Map<ackId, WeakRef<Message>>).
 * WeakRef allows Messages to be GC'd even if never acknowledged (network failures, crashes).
 */
const messageToContext = new WeakMap() // Message -> context (auto-cleanup on GC)
const ackIdToMessage = new Map() // ackId -> WeakRef<Message> (needs cleanup)

const ackMapCleanup = new FinalizationRegistry((ackId) => {
  ackIdToMessage.delete(ackId) // Remove orphaned ackId when Message is GC'd
})

class GoogleCloudPubsubConsumerPlugin extends ConsumerPlugin {
  static id = 'google-cloud-pubsub'
  static operation = 'receive'

  constructor (...args) {
    super(...args)

    /**
     * Channel: message:ack-store
     * When message.ack() is called, capture and store the current async context.
     * Use WeakRef to allow Message GC even if never acknowledged.
     */
    this.addSub('apm:google-cloud-pubsub:message:ack-store', (ctx) => {
      const { message, ackId } = ctx
      const currentStore = storage('legacy').getStore()

      if (currentStore) {
        messageToContext.set(message, currentStore)
        ackIdToMessage.set(ackId, new WeakRef(message))
        ackMapCleanup.register(message, ackId, message)
      }
    })

    /**
     * Channel: message:ack-retrieve
     * When acknowledge() API is called, retrieve stored context for the ackIds.
     * Map: ackId -> WeakRef<Message> -> stored context.
     * Clean up immediately after acknowledge (happy path), or via FinalizationRegistry (GC).
     */
    this.addSub('apm:google-cloud-pubsub:message:ack-retrieve', ({ ackIds, api, ctx }) => {
      for (const ackId of ackIds) {
        const weakRef = ackIdToMessage.get(ackId)
        if (weakRef) {
          const message = weakRef.deref()
          if (message) {
            const storedContext = messageToContext.get(message)
            if (storedContext) {
              ctx.storedContext = storedContext
              break
            }
          }
        }
      }

      if (api === 'acknowledge') {
        ackIds.forEach(ackId => ackIdToMessage.delete(ackId))
      }
    })
  }

  #reconstructPubSubRequestContext (attrs) {
    const traceIdLower = attrs['_dd.pubsub_request.trace_id']
    const spanId = attrs['_dd.pubsub_request.span_id']
    const traceIdUpper = attrs['_dd.pubsub_request.p.tid']

    if (!traceIdLower || !spanId) return null

    const traceId128 = traceIdUpper ? traceIdUpper + traceIdLower : traceIdLower.padStart(32, '0')
    const traceId = id(traceId128, 16)
    const parentId = id(spanId, 16)

    const tags = {}
    if (traceIdUpper) tags['_dd.p.tid'] = traceIdUpper

    return new SpanContext({
      traceId,
      spanId: parentId,
      tags
    })
  }

  bindStart (ctx) {
    const { message } = ctx
    const subscription = message._subscriber._subscription
    const topic = subscription?.metadata?.topic || message.attributes?.['pubsub.topic']

    const batchRequestTraceId = message.attributes?.['_dd.pubsub_request.trace_id']
    const batchRequestSpanId = message.attributes?.['_dd.pubsub_request.span_id']

    // Parse batch metadata once upfront for reuse
    const batchSizeStr = message.attributes?.['_dd.batch.size']
    const batchIndexStr = message.attributes?.['_dd.batch.index']
    const batchSize = batchSizeStr ? Number(batchSizeStr) : undefined
    const batchIndex = batchIndexStr ? Number(batchIndexStr) : undefined

    let childOf = this.tracer.extract('text_map', message.attributes)

    const isFirstMessage = batchIndex === 0
    if (isFirstMessage && batchRequestSpanId) {
      const pubsubRequestContext = this.#reconstructPubSubRequestContext(message.attributes)
      if (pubsubRequestContext) {
        childOf = pubsubRequestContext
      }
    }

    const topicName = topic?.slice(topic.lastIndexOf('/') + 1) ??
      subscription.name.slice(subscription.name.lastIndexOf('/') + 1)
    const baseService = this.tracer._service || 'unknown'
    const serviceName = this.config.service || `${baseService}-pubsub`
    const meta = {
      'gcloud.project_id': subscription.pubsub.projectId,
      'pubsub.topic': topic,
      'span.kind': 'consumer',
      'pubsub.delivery_method': 'pull',
      'pubsub.span_type': 'message_processing',
      'messaging.operation': 'receive',
      base_service: baseService,
      service_override_type: 'custom'
    }

    if (batchRequestTraceId && batchRequestSpanId) {
      meta['pubsub.batch.request_trace_id'] = batchRequestTraceId
      meta['pubsub.batch.request_span_id'] = batchRequestSpanId
      meta['_dd.pubsub_request.trace_id'] = batchRequestTraceId
      meta['_dd.pubsub_request.span_id'] = batchRequestSpanId
      // Use JSON format like producer for proper span link parsing
      meta['_dd.span_links'] = JSON.stringify([{
        trace_id: batchRequestTraceId,
        span_id: batchRequestSpanId,
        flags: 0
      }])
    }

    const metrics = {
      'pubsub.ack': 0
    }

    if (batchSize) {
      metrics['pubsub.batch.message_count'] = batchSize
      metrics['pubsub.batch.size'] = batchSize
    }
    if (batchIndex !== undefined) {
      metrics['pubsub.batch.message_index'] = batchIndex
      metrics['pubsub.batch.index'] = batchIndex
    }

    if (batchSize && batchIndex !== undefined) {
      meta['pubsub.batch.description'] = `Message ${batchIndex + 1} of ${batchSize}`
    }

    const span = this.startSpan({
      childOf,
      resource: `Message from ${topicName}`,
      type: 'worker',
      service: serviceName,
      meta,
      metrics
    }, ctx)

    if (message.id) {
      span.setTag('pubsub.message_id', message.id)
    }
    if (message.publishTime) {
      span.setTag('pubsub.publish_time', message.publishTime.toISOString())
    }

    if (message.attributes) {
      const publishStartTime = message.attributes['x-dd-publish-start-time']
      if (publishStartTime) {
        const deliveryDuration = Date.now() - Number(publishStartTime)
        span.setTag('pubsub.delivery_duration_ms', deliveryDuration)
      }
    }

    if (this.config.dsmEnabled && message?.attributes) {
      const payloadSize = getMessageSize(message)
      this.tracer.decodeDataStreamsContext(message.attributes)
      this.tracer
        .setCheckpoint(['direction:in', `topic:${topic}`, 'type:google-pubsub'], span, payloadSize)
    }

    return ctx.currentStore
  }

  bindFinish (ctx) {
    const { message } = ctx
    const span = ctx.currentStore?.span

    if (!span) return ctx.parentStore

    if (message?._handled) {
      span.setTag('pubsub.ack', 1)
    }

    super.finish()
    return ctx.parentStore
  }
}

module.exports = GoogleCloudPubsubConsumerPlugin
