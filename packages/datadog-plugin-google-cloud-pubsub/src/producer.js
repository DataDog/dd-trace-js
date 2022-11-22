'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

class GoogleCloudPubsubProducerPlugin extends ProducerPlugin {
  static get name () { return 'google-cloud-pubsub' }
  static get operation () { return 'request' }

  start ({ cfg, projectId, messages }) {
    if (cfg.method !== 'publish') return

    const topic = cfg.reqOpts.topic
    const span = this.startSpan('pubsub.request', { // TODO: rename
      service: this.config.service || `${this.tracer._service}-pubsub`,
      resource: `${cfg.method} ${topic}`,
      kind: 'producer',
      meta: {
        'gcloud.project_id': projectId,
        'pubsub.method': cfg.method, // TODO: remove
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
