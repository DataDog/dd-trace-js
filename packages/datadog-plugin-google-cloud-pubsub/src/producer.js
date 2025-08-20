'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { DsmPathwayCodec, getHeadersSize } = require('../../dd-trace/src/datastreams')

class GoogleCloudPubsubProducerPlugin extends ProducerPlugin {
  static id = 'google-cloud-pubsub'
  static operation = 'request'

  bindStart (ctx) {
    const { request, api, projectId } = ctx

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
    }, ctx)

    for (const msg of messages) {
      if (!msg.attributes) {
        msg.attributes = {}
      }
      this.tracer.inject(span, 'text_map', msg.attributes)

      // Also inject project_id and topic for consumer correlation
      msg.attributes['gcloud.project_id'] = projectId
      msg.attributes['pubsub.topic'] = topic

      // Record publish start time for delivery duration measurement on consumer
      if (!msg.attributes['x-dd-publish-start-time']) {
        msg.attributes['x-dd-publish-start-time'] = String(Date.now())
      }

      if (this.config.dsmEnabled) {
        const payloadSize = getHeadersSize(msg)
        const dataStreamsContext = this.tracer
          .setCheckpoint(['direction:out', `topic:${topic}`, 'type:google-pubsub'], span, payloadSize)
        DsmPathwayCodec.encode(dataStreamsContext, msg.attributes)
      }
    }

    return ctx.currentStore
  }
}

module.exports = GoogleCloudPubsubProducerPlugin
