'use strict'

const LOG_PREFIX = '[DD-PUBSUB-CONSUMER]'

const { getMessageSize } = require('../../dd-trace/src/datastreams')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const SpanContext = require('../../dd-trace/src/opentracing/span_context')
const id = require('../../dd-trace/src/id')

console.log(`${LOG_PREFIX} ========================================`)
console.log(`${LOG_PREFIX} LOADING GoogleCloudPubsubConsumerPlugin at ${new Date().toISOString()}`)
console.log(`${LOG_PREFIX} ========================================`)

class GoogleCloudPubsubConsumerPlugin extends ConsumerPlugin {
  static id = 'google-cloud-pubsub'
  static operation = 'receive'

  constructor (...args) {
    console.log(`${LOG_PREFIX} constructor() called with args:`, args.length)
    super(...args)
    console.log(`${LOG_PREFIX} ========================================`)
    console.log(`${LOG_PREFIX} CONSUMER PLUGIN INSTANTIATED SUCCESSFULLY`)
    console.log(`${LOG_PREFIX} This plugin should now be subscribed to:`)
    console.log(`${LOG_PREFIX}   - apm:google-cloud-pubsub:receive:start`)
    console.log(`${LOG_PREFIX}   - apm:google-cloud-pubsub:receive:finish`)
    console.log(`${LOG_PREFIX} ========================================`)
  }

  _reconstructPubSubRequestContext (attrs) {
    const traceIdLower = attrs['_dd.pubsub_request.trace_id']
    const spanId = attrs['_dd.pubsub_request.span_id']
    const traceIdUpper = attrs['_dd.pubsub_request.p.tid']

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
    const timestamp = new Date().toISOString()
    console.log(`${LOG_PREFIX} ========================================`)
    console.log(`${LOG_PREFIX} [${timestamp}] bindStart() CALLED`)
    console.log(`${LOG_PREFIX} Context: { hasMessage: ${!!ctx.message}, messageId: ${ctx.message?.id} }`)
    console.log(`${LOG_PREFIX} ========================================`)
    const { message } = ctx
    
    // Get subscription and topic with fallbacks
    let subscription, topic, topicName
    try {
      subscription = message._subscriber._subscription
      topic = (subscription.metadata && subscription.metadata.topic) ||
              (message.attributes && message.attributes['pubsub.topic']) ||
              (message.attributes && message.attributes['gcloud.project_id']
                ? `projects/${message.attributes['gcloud.project_id']}/topics/unknown`
                : null)
      topicName = topic ? topic.split('/').pop() : subscription.name.split('/').pop()
      console.log(`${LOG_PREFIX} Extracted: topicName="${topicName}", topic="${topic}"`)
    } catch (e) {
      console.log(`${LOG_PREFIX} Extraction failed (${e.message}), using fallback`)
      // Fallback if subscription structure is different
      topic = message.attributes?.['pubsub.topic'] || null
      topicName = topic ? topic.split('/').pop() : 'unknown'
      // Create minimal subscription fallback to prevent crashes
      subscription = {
        name: 'unknown-subscription',
        metadata: { topic },
        pubsub: { projectId: message.attributes?.['gcloud.project_id'] || 'unknown' }
      }
    }

    const batchRequestTraceId = message.attributes?.['_dd.pubsub_request.trace_id']
    const batchRequestSpanId = message.attributes?.['_dd.pubsub_request.span_id']
    const batchSize = message.attributes?.['_dd.batch.size']
    const batchIndex = message.attributes?.['_dd.batch.index']

    let childOf = this.tracer.extract('text_map', message.attributes) || null

    // Try to use batch context for first message
    const isFirstMessage = batchIndex === '0' || batchIndex === 0
    if (isFirstMessage && batchRequestSpanId) {
      try {
        const pubsubRequestContext = this._reconstructPubSubRequestContext(message.attributes)
        if (pubsubRequestContext) {
          childOf = pubsubRequestContext
        }
      } catch (e) {
        // Ignore batch context reconstruction errors
      }
    }

    const baseService = this.tracer._service || 'unknown'
    const serviceName = this.config.service || `${baseService}-pubsub`
    
    // Get project ID safely
    let projectId
    try {
      projectId = subscription?.pubsub?.projectId || message.attributes?.['gcloud.project_id'] || 'unknown'
    } catch (e) {
      projectId = message.attributes?.['gcloud.project_id'] || 'unknown'
    }

    const meta = {
      'gcloud.project_id': projectId,
      'pubsub.topic': topic,
      'span.kind': 'consumer',
      'pubsub.delivery_method': 'pull',
      'pubsub.span_type': 'message_processing',
      'messaging.operation': 'receive'
    }

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

    console.log(`${LOG_PREFIX} Creating consumer span:`)
    console.log(`${LOG_PREFIX}   resource: "Message from ${topicName}"`)
    console.log(`${LOG_PREFIX}   type: "worker"`)
    console.log(`${LOG_PREFIX}   service: "${serviceName}"`)
    console.log(`${LOG_PREFIX}   hasChildOf: ${!!childOf}`)

    const span = this.startSpan({
      childOf,
      resource: `Message from ${topicName}`,
      type: 'worker',
      service: serviceName,
      meta,
      metrics
    }, ctx)

    console.log(`${LOG_PREFIX} ========================================`)
    console.log(`${LOG_PREFIX} CONSUMER SPAN CREATED SUCCESSFULLY`)
    console.log(`${LOG_PREFIX}   spanId: ${span?.context()?.toSpanId()}`)
    console.log(`${LOG_PREFIX}   name: ${span?._name}`)
    console.log(`${LOG_PREFIX}   type: ${span?._type}`)
    console.log(`${LOG_PREFIX} ========================================`)

    if (message.id) {
      span.setTag('pubsub.message_id', message.id)
    }
    if (message.publishTime) {
      span.setTag('pubsub.publish_time', message.publishTime.toISOString())
    }

    if (message.attributes) {
      const publishStartTime = message.attributes['x-dd-publish-start-time']
      if (publishStartTime) {
        const deliveryDuration = Date.now() - Number.parseInt(publishStartTime, 10)
        span.setTag('pubsub.delivery_duration_ms', deliveryDuration)
      }

      const pubsubRequestTraceId = message.attributes['_dd.pubsub_request.trace_id']
      const pubsubRequestSpanId = message.attributes['_dd.pubsub_request.span_id']
      const batchSize = message.attributes['_dd.batch.size']
      const batchIndex = message.attributes['_dd.batch.index']

      if (pubsubRequestTraceId && pubsubRequestSpanId) {
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
    const timestamp = new Date().toISOString()
    console.log(`${LOG_PREFIX} ========================================`)
    console.log(`${LOG_PREFIX} [${timestamp}] bindFinish() CALLED`)
    console.log(`${LOG_PREFIX} Context: { hasMessage: ${!!ctx.message}, hasCurrentStore: ${!!ctx.currentStore}, hasSpan: ${!!ctx.currentStore?.span}, messageHandled: ${ctx.message?._handled} }`)
    const { message } = ctx
    const span = ctx.currentStore?.span

    if (span && message?._handled) {
      console.log(`${LOG_PREFIX} Setting pubsub.ack=1 on span ${span?.context()?.toSpanId()}`)
      span.setTag('pubsub.ack', 1)
    }

    console.log(`${LOG_PREFIX} Calling super.bindFinish()`)
    const result = super.bindFinish(ctx)
    console.log(`${LOG_PREFIX} bindFinish() COMPLETE`)
    console.log(`${LOG_PREFIX} ========================================`)
    return result
  }
}

module.exports = GoogleCloudPubsubConsumerPlugin
