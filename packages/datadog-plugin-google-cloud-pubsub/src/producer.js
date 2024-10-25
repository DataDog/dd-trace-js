'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { DsmPathwayCodec } = require('../../dd-trace/src/datastreams/pathway')
const { getHeadersSize } = require('../../dd-trace/src/datastreams/processor')

class GoogleCloudPubsubProducerPlugin extends ProducerPlugin {
  static get id () { return 'google-cloud-pubsub' }
  static get operation () { return 'request' }

  start ({ request, api, projectId }) {
    if (api !== 'publish') return

    const messages = request.messages || []
    const topic = request.topic
    const span = this.startSpan({ // TODO: rename
      resource: `${api} ${topic}`,
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
      if (this.config.dsmEnabled) {
        const payloadSize = getHeadersSize(msg)
        const dataStreamsContext = this.tracer
          .setCheckpoint(['direction:out', `topic:${topic}`, 'type:google-pubsub'], span, payloadSize)
        DsmPathwayCodec.encode(dataStreamsContext, msg.attributes)
      }
    }
  }
}

module.exports = GoogleCloudPubsubProducerPlugin
