'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { getMessageSize } = require('../../dd-trace/src/datastreams')
const { convertToTextMap } = require('./utils')

class KafkajsBatchConsumerPlugin extends ConsumerPlugin {
  static get id () { return 'kafkajs' }
  static get operation () { return 'consume-batch' }

  start (ctx) {
    const { topic, messages, groupId, clusterId } = ctx.extractedArgs || ctx

    if (!this.config.dsmEnabled) return
    for (const message of messages) {
      if (!message || !message.headers) continue
      const payloadSize = getMessageSize(message)
      this.tracer.decodeDataStreamsContext(convertToTextMap(message.headers))
      const edgeTags = ['direction:in', `group:${groupId}`, `topic:${topic}`, 'type:kafka']
      if (clusterId) {
        edgeTags.push(`kafka_cluster_id:${clusterId}`)
      }
      this.tracer.setCheckpoint(edgeTags, null, payloadSize)
    }
  }
}

module.exports = KafkajsBatchConsumerPlugin
