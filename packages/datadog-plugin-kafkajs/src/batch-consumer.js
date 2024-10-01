const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { getMessageSize } = require('../../dd-trace/src/datastreams/processor')
const { extract } = require('./utils')

class KafkajsBatchConsumerPlugin extends ConsumerPlugin {
  static get id () { return 'kafkajs' }
  static get operation () { return 'consume-batch' }

  start ({ topic, partition, messages, groupId }) {
    const span = this.startSpan({
      resource: topic,
      type: 'worker',
      meta: {
        component: 'kafkajs',
        'kafka.topic': topic,
        'messaging.destination.name': topic,
        'messaging.system': 'kafka'
      },
      metrics: {
        'kafka.partition': partition,
        'messaging.batch.message_count': messages.length
      }
    })

    for (const message of messages) {
      if (!message || !message.headers) continue

      const ctx = extract(this.tracer, message.headers)

      span.addLink(ctx)

      if (!this.config.dsmEnabled) continue
      const payloadSize = getMessageSize(message)
      this.tracer.decodeDataStreamsContext(message.headers)
      this.tracer
        .setCheckpoint(['direction:in', `group:${groupId}`, `topic:${topic}`, 'type:kafka'], null, payloadSize)
    }
  }
}

module.exports = KafkajsBatchConsumerPlugin
