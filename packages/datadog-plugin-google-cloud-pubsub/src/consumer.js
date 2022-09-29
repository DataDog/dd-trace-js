'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')

class GoogleCloudPubsubConsumerPlugin extends ConsumerPlugin {
  static get name () { return 'google-cloud-pubsub' }
  static get operation () { return 'receive' }

  start ({ message }) {
    const subscription = message._subscriber._subscription
    const topic = subscription.metadata && subscription.metadata.topic
    const childOf = this.tracer.extract('text_map', message.attributes) || null

    this.startSpan('pubsub.receive', {
      childOf,
      service: this.config.service,
      resource: topic,
      kind: 'consumer',
      type: 'worker',
      meta: {
        'component': '@google-cloud/pubsub',
        'gcloud.project_id': subscription.pubsub.projectId,
        'pubsub.topic': topic
      },
      metrics: {
        'pubsub.ack': 0
      }
    })
  }

  finish (message) {
    const span = this.activeSpan()

    if (message.message._handled) {
      span.setTag('pubsub.ack', 1)
    }

    span.finish()
  }
}

module.exports = GoogleCloudPubsubConsumerPlugin
