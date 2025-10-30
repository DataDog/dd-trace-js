'use strict'

const { getMessageSize } = require('../../dd-trace/src/datastreams')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')

class GoogleCloudPubsubConsumerPlugin extends ConsumerPlugin {
  static id = 'google-cloud-pubsub'
  static operation = 'receive'

  bindStart (ctx) {
    const { message } = ctx
    const subscription = message._subscriber._subscription
    const topic = subscription.metadata && subscription.metadata.topic
    const childOf = this.tracer.extract('text_map', message.attributes) || null

    // Create pubsub.delivery span
    const span = this.startSpan({
      childOf,
      resource: topic,
      type: 'worker',
      meta: {
        'gcloud.project_id': subscription.pubsub.projectId,
        'pubsub.topic': topic,
        'span.kind': 'consumer',
        operation: 'pubsub.delivery'
      },
      metrics: {
        'pubsub.ack': 0
      }
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
