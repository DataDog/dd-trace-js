'use strict'

const { getMessageSize } = require('../../dd-trace/src/datastreams')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const SpanContext = require('../../dd-trace/src/opentracing/span_context')
const id = require('../../dd-trace/src/id')

class GoogleCloudPubsubConsumerPlugin extends ConsumerPlugin {
  static id = 'google-cloud-pubsub'
  static operation = 'receive'

  // Reconstruct a SpanContext for the pubsub.request span
  // This creates proper Identifier objects that the encoder can serialize
  _reconstructPubSubRequestContext (attrs) {
    const traceIdLower = attrs['_dd.pubsub_request.trace_id']
    const spanId = attrs['_dd.pubsub_request.span_id']
    const traceIdUpper = attrs['_dd.p.tid']

    if (!traceIdLower || !spanId) return null

    try {
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
    } catch {
      return null
    }
  }

  bindStart (ctx) {
    const { message } = ctx
    const subscription = message._subscriber._subscription
    // Get topic from metadata or message attributes (attributes more reliable for pull subscriptions)
    const topic = (subscription.metadata && subscription.metadata.topic) ||
                  (message.attributes && message.attributes['pubsub.topic']) ||
                  (message.attributes && message.attributes['gcloud.project_id'] ? 
                    `projects/${message.attributes['gcloud.project_id']}/topics/unknown` : null)
    
    // Extract batch metadata from message attributes
    const batchRequestTraceId = message.attributes?.['_dd.pubsub_request.trace_id']
    const batchRequestSpanId = message.attributes?.['_dd.pubsub_request.span_id']
    const batchSize = message.attributes?.['_dd.batch.size']
    const batchIndex = message.attributes?.['_dd.batch.index']

    // Extract the standard context (this gets us the full 128-bit trace ID, sampling priority, etc.)
    let childOf = this.tracer.extract('text_map', message.attributes) || null
    
    // Only reparent to pubsub.request for the FIRST message in the batch (index 0)
    // Messages 2-N are in separate traces and should stay as children of their original parent
    const isFirstMessage = batchIndex === '0' || batchIndex === 0
    if (isFirstMessage && batchRequestSpanId) {
      // Reconstruct a proper SpanContext for the pubsub.request span
      // This ensures pubsub.receive becomes a child of pubsub.request (not triggerPubsub)
      const pubsubRequestContext = this._reconstructPubSubRequestContext(message.attributes)
      if (pubsubRequestContext) {
        childOf = pubsubRequestContext
      }
    }

    // Extract topic name for better resource naming
    const topicName = topic ? topic.split('/').pop() : subscription.name.split('/').pop()
    // Create pubsub.receive span (note: operation name will be 'google-cloud-pubsub.receive')
    // Use a separate service name (like push subscriptions do) for better service map visibility
    const baseService = this.tracer._service || 'unknown'
    const serviceName = this.config.service || `${baseService}-pubsub`
    
    // Build meta object with batch metadata if available
    const meta = {
      'gcloud.project_id': subscription.pubsub.projectId,
      'pubsub.topic': topic,
      'span.kind': 'consumer',
      'pubsub.delivery_method': 'pull',
      'pubsub.span_type': 'message_processing', // Easy filtering in Datadog
      'messaging.operation': 'receive' // Standard tag 
    }

    // Add batch metadata tags for correlation
    if (batchRequestTraceId) {
      meta['pubsub.batch.request_trace_id'] = batchRequestTraceId
    }
    if (batchRequestSpanId) {
      meta['pubsub.batch.request_span_id'] = batchRequestSpanId
      // Also add span link metadata
      meta['_dd.pubsub_request.trace_id'] = batchRequestTraceId
      meta['_dd.pubsub_request.span_id'] = batchRequestSpanId
      if (batchRequestTraceId && batchRequestSpanId) {
        meta['_dd.span_links'] = `${batchRequestTraceId}:${batchRequestSpanId}`
      }
    }

    const metrics = {
      'pubsub.ack': 0
    }

    // Add batch size and index if available
    if (batchSize) {
      metrics['pubsub.batch.message_count'] = Number.parseInt(batchSize, 10)
      metrics['pubsub.batch.size'] = Number.parseInt(batchSize, 10)
    }
    if (batchIndex !== undefined) {
      metrics['pubsub.batch.message_index'] = Number.parseInt(batchIndex, 10)
      metrics['pubsub.batch.index'] = Number.parseInt(batchIndex, 10)
    }

    // Add batch description
    if (batchSize && batchIndex !== undefined) {
      const index = Number.parseInt(batchIndex, 10)
      const size = Number.parseInt(batchSize, 10)
      meta['pubsub.batch.description'] = `Message ${index + 1} of ${size}`
    }
    
    const span = this.startSpan({
      childOf,
      resource: `Message from ${topicName}`, // More descriptive resource name
      type: 'worker',
      service: serviceName, // Use integration-specific service name
      meta,
      metrics
    }, ctx) 

    // Add message metadata
    if (message.id) {
      span.setTag('pubsub.message_id', message.id)
    }
    if (message.publishTime) {
      span.setTag('pubsub.publish_time', message.publishTime.toISOString())
    }

    // Calculate delivery duration if publish time is available
    if (message.attributes) {
      const publishStartTime = message.attributes['x-dd-publish-start-time']
      if (publishStartTime) {
        const deliveryDuration = Date.now() - Number.parseInt(publishStartTime, 10)
        span.setTag('pubsub.delivery_duration_ms', deliveryDuration)
      }

      // Extract and link to the pubsub.request span that sent this message
      const pubsubRequestTraceId = message.attributes['_dd.pubsub_request.trace_id']
      const pubsubRequestSpanId = message.attributes['_dd.pubsub_request.span_id']
      const batchSize = message.attributes['_dd.batch.size']
      const batchIndex = message.attributes['_dd.batch.index']

      if (pubsubRequestTraceId && pubsubRequestSpanId) {
        // Add span link metadata to connect delivery span to the pubsub.request span
        span.setTag('_dd.pubsub_request.trace_id', pubsubRequestTraceId)
        span.setTag('_dd.pubsub_request.span_id', pubsubRequestSpanId)
        span.setTag('_dd.span_links', `${pubsubRequestTraceId}:${pubsubRequestSpanId}`)
      }

      if (batchSize) {
        span.setTag('pubsub.batch.size', Number.parseInt(batchSize, 10))
      }
      if (batchIndex) {
        span.setTag('pubsub.batch.index', Number.parseInt(batchIndex, 10))
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
    const span = ctx.currentStore.span

    if (message?._handled) {
      span.setTag('pubsub.ack', 1)
    }

    super.finish()
    return ctx.parentStore
  }
}

module.exports = GoogleCloudPubsubConsumerPlugin
