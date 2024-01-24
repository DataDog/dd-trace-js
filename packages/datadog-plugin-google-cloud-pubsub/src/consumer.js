'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')

class GoogleCloudPubsubConsumerPlugin extends ConsumerPlugin {
  static get id () { return 'google-cloud-pubsub' }
  static get operation () { return 'receive' }

  start ({ message }) {
    const subscription = message._subscriber._subscription
    const topic = subscription.metadata && subscription.metadata.topic
    const childOf = this.tracer.extract('text_map', message.attributes) || null

    this.startSpan({
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
  }

  finish (message) {
    const span = this.activeSpan

    if (!span) return

    if (message.message._handled) {
      span.setTag('pubsub.ack', 1)
    }

    super.finish()
  }
}

module.exports = GoogleCloudPubsubConsumerPlugin
