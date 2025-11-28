'use strict'

const { getMessageSize } = require('../../dd-trace/src/datastreams')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')

class GoogleCloudPubsubConsumerPlugin extends ConsumerPlugin {
  static id = 'google-cloud-pubsub'
  static operation = 'receive'

  bindStart (ctx) {
    console.log('[CONSUMER-PLUGIN] bindStart called, message:', ctx.message?.id)
    const { message } = ctx
    const subscription = message._subscriber._subscription
    const topic = subscription.metadata && subscription.metadata.topic
    const childOf = this.tracer.extract('text_map', message.attributes) || null
    console.log('[CONSUMER-PLUGIN] topic:', topic, 'childOf:', !!childOf)

    const span = this.startSpan({
      childOf,
      resource: topic,
      type: 'worker',
      meta: {
        'gcloud.project_id': subscription.pubsub.projectId,
        'pubsub.topic': topic
      },
      metrics: {
        'pubsub.ack': 0
      }
    }, ctx)
    console.log('[CONSUMER-PLUGIN] Span created:', span?.context()?._spanId?.toString(16))

    if (this.config.dsmEnabled && message?.attributes) {
      const payloadSize = getMessageSize(message)
      this.tracer.decodeDataStreamsContext(message.attributes)
      this.tracer
        .setCheckpoint(['direction:in', `topic:${topic}`, 'type:google-pubsub'], span, payloadSize)
    }

    return ctx.currentStore
  }

  bindFinish (ctx) {
    console.log('[CONSUMER-PLUGIN] bindFinish called, message:', ctx.message?.id)
    const { message } = ctx
    const span = ctx.currentStore.span
    console.log('[CONSUMER-PLUGIN] span from ctx:', span?.context()?._spanId?.toString(16))

    if (message?._handled) {
      span.setTag('pubsub.ack', 1)
      console.log('[CONSUMER-PLUGIN] Set pubsub.ack = 1')
    }

    super.finish()
    console.log('[CONSUMER-PLUGIN] super.finish() called, span should be finished')

    return ctx.parentStore
  }
}

module.exports = GoogleCloudPubsubConsumerPlugin
