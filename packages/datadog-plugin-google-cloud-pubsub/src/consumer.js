'use strict'

const { getMessageSize, CONTEXT_PROPAGATION_KEY } = require('../../dd-trace/src/datastreams/processor')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')

class GoogleCloudPubsubConsumerPlugin extends ConsumerPlugin {
  static get id () { return 'google-cloud-pubsub' }
  static get operation () { return 'receive' }

  start ({ message }) {
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
    })
    if (this.config.dsmEnabled && message.attributes && message.attributes.CONTEXT_PROPAGATION_KEY) {
      const payloadSize = getMessageSize(message)
      const topicName = topic.split('/').pop()
      this.tracer.decodeDataStreamsContext(Buffer.from(JSON.parse(message.attributes[CONTEXT_PROPAGATION_KEY])))
      this.tracer
        .setCheckpoint(['direction:in', `topic:${topicName}`, 'type:pub/sub'], span, payloadSize)
    }
  }

  finish (message) {
    const span = this.activeSpan

    if (message.message._handled) {
      span.setTag('pubsub.ack', 1)
    }

    super.finish()
  }
}

module.exports = GoogleCloudPubsubConsumerPlugin
