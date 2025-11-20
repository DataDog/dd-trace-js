'use strict'

const { getMessageSize } = require('../../dd-trace/src/datastreams')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const SpanContext = require('../../dd-trace/src/opentracing/span_context')
const id = require('../../dd-trace/src/id')

class GoogleCloudPubsubConsumerPlugin extends ConsumerPlugin {
  static id = 'google-cloud-pubsub'
  static operation = 'receive'

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
    const { message } = ctx
    const subscription = message._subscriber._subscription
    const topic = (subscription.metadata && subscription.metadata.topic) ||
                  (message.attributes && message.attributes['pubsub.topic']) ||
                  (message.attributes && message.attributes['gcloud.project_id']
                    ? `projects/${message.attributes['gcloud.project_id']}/topics/unknown`
                    : null)

    const batchRequestTraceId = message.attributes?.['_dd.pubsub_request.trace_id']
    const batchRequestSpanId = message.attributes?.['_dd.pubsub_request.span_id']
    const batchSize = message.attributes?.['_dd.batch.size']
    const batchIndex = message.attributes?.['_dd.batch.index']

    let childOf = this.tracer.extract('text_map', message.attributes) || null

    const isFirstMessage = batchIndex === '0' || batchIndex === 0
    if (isFirstMessage && batchRequestSpanId) {
      const pubsubRequestContext = this._reconstructPubSubRequestContext(message.attributes)
      if (pubsubRequestContext) {
        childOf = pubsubRequestContext
      }
    }

    const topicName = topic ? topic.split('/').pop() : subscription.name.split('/').pop()
    const baseService = this.tracer._service || 'unknown'
    const serviceName = this.config.service || `${baseService}-pubsub`

    const meta = {
      'gcloud.project_id': subscription.pubsub.projectId,
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
    const { message } = ctx
    const span = ctx.currentStore?.span

    if (span && message?._handled) {
      span.setTag('pubsub.ack', 1)
    }

    this.finish(ctx)
    return ctx.parentStore
  }
}

module.exports = GoogleCloudPubsubConsumerPlugin
