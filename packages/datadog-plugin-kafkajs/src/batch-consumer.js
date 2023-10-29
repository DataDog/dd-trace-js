'use strict'
const ConsumerPlugin = require('dd-trace/packages/dd-trace/src/plugins/consumer')

class KafkajsBatchConsumerPlugin extends ConsumerPlugin {
  static get id () {
    return 'kafkajs'
  }
  static get operation () {
    return 'consume-batch'
  }

  start ({ topic, partition, messages, groupId }) {
    if (this.config.dsmEnabled) {
      this.tracer.setCheckpoint(['direction:in', `group:${groupId}`, `topic:${topic}`, 'type:kafka'])
    }
    this.startSpan({
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
  }
}

module.exports = KafkajsBatchConsumerPlugin
