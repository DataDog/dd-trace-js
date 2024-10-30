const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { getMessageSize } = require('../../dd-trace/src/datastreams/processor')

class KafkajsBatchConsumerPlugin extends ConsumerPlugin {
  static get id () { return 'kafkajs' }
  static get operation () { return 'consume-batch' }

  start ({ topic, partition, messages, groupId, clusterId }) {
    if (!this.config.dsmEnabled) return
    for (const message of messages) {
      if (!message || !message.headers) continue
      const payloadSize = getMessageSize(message)
      this.tracer.decodeDataStreamsContext(message.headers)
      const edgeTags = ['direction:in', `group:${groupId}`, `topic:${topic}`, 'type:kafka']
      if (clusterId) {
        edgeTags.push(`kafka_cluster_id:${clusterId}`)
      }
      this.tracer.setCheckpoint(edgeTags, null, payloadSize)
    }
  }
}

module.exports = KafkajsBatchConsumerPlugin
