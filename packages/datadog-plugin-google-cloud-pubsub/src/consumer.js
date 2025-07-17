'use strict'

const { getMessageSize } = require('../../dd-trace/src/datastreams')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')

class GoogleCloudPubsubConsumerPlugin extends ConsumerPlugin {
  static get id () { return 'google-cloud-pubsub' }
  static get operation () { return 'receive' }

  bindStart (ctx) {
    const { message } = ctx
    const subscription = message._subscriber._subscription
    const topic = subscription.metadata && subscription.metadata.topic
    const childOf = this.tracer.extract('text_map', message.attributes) || null

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
