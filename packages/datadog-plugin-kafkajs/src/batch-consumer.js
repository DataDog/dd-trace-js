const ConsumerPlugin = require('dd-trace/packages/dd-trace/src/plugins/consumer')
const { getMessageSize } = require('../../dd-trace/src/datastreams/processor')
const { DsmPathwayCodec } = require('../../dd-trace/src/datastreams/pathway')

class KafkajsBatchConsumerPlugin extends ConsumerPlugin {
  static get operation () {
    return 'consume-batch'
  }

  start ({ topic, partition, messages, groupId }) {
    const span = this.startSpan({
      resource: topic,
      type: 'worker',
      meta: {
        component: 'kafkajs',
        'kafka.topic': topic,
        'kafka.message.offset': messages[0].offset,
        'kafka.message.offset.last': messages[messages.length - 1].offset
      },
      metrics: {
        'kafka.partition': partition,
        'kafka.batch_size': messages.length
      }
    })

    if (this.config.dsmEnabled) {
      for (const message of messages) {
        if (message?.headers && DsmPathwayCodec.contextExists(message.headers)) {
          const payloadSize = getMessageSize(message)
          this.tracer.decodeDataStreamsContext(message.headers)
          this.tracer
            .setCheckpoint(['direction:in', `group:${groupId}`, `topic:${topic}`, 'type:kafka'], span, payloadSize)
        }
      }
    }
  }
}

module.exports = KafkajsBatchConsumerPlugin
