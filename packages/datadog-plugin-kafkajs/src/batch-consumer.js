const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { extract } = require('./utils')
const { getMessageSize } = require('../../dd-trace/src/datastreams/processor')
const { DsmPathwayCodec } = require('../../dd-trace/src/datastreams/pathway')

class KafkajsBatchConsumerPlugin extends ConsumerPlugin {
  static get id () { return 'kafkajs' }
  static get operation () { return 'consume-batch' }

  start ({ topic, partition, messages, groupId }) {
    let childOf
    for (const message of messages) {
      childOf = extract(this.tracer, message?.headers)
      if (childOf._traceId !== null) {
        break
      }
    }

    const span = this.startSpan({
      childOf,
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
