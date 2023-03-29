'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

class GoogleCloudPubsubProducerPlugin extends ProducerPlugin {
  static get id () { return 'google-cloud-pubsub' }
  static get operation () { return 'request' }

  start ({ request, api, projectId }) {
    if (api !== 'publish') return

    const messages = request.messages || []
    const topic = request.topic
    const span = this.startSpan(this.operationName(), { // TODO: rename
      service: this.config.service || this.serviceName({ service: this.tracer._service }),
      resource: `${api} ${topic}`,
      kind: 'producer',
      meta: {
        'gcloud.project_id': projectId,
        'pubsub.method': api, // TODO: remove
        'pubsub.topic': topic
      }
    })

    for (const msg of messages) {
      if (!msg.attributes) {
        msg.attributes = {}
      }
      this.tracer.inject(span, 'text_map', msg.attributes)
    }
  }
}

module.exports = GoogleCloudPubsubProducerPlugin
