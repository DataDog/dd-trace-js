const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { getMessageSize } = require('../../dd-trace/src/datastreams/processor')
const { DsmPathwayCodec } = require('../../dd-trace/src/datastreams/pathway')

class KafkajsBatchConsumerPlugin extends ConsumerPlugin {
  static get id () { return 'kafkajs' }
  static get operation () { return 'consume-batch' }

  start ({ topic, partition, messages, groupId }) {
    if (!this.config.dsmEnabled) return
    for (const message of messages) {
      if (!message || !message.headers || !DsmPathwayCodec.contextExists(message.headers)) continue
      const payloadSize = getMessageSize(message)
      this.tracer.decodeDataStreamsContext(message.headers)
      this.tracer
        .setCheckpoint(['direction:in', `group:${groupId}`, `topic:${topic}`, 'type:kafka'], null, payloadSize)
    }
  }
}

module.exports = KafkajsBatchConsumerPlugin
