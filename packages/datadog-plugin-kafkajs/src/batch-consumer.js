'use strict'
const ConsumerPlugin = require('dd-trace/packages/dd-trace/src/plugins/consumer')

const kafkaMessageStub = { headers: [] }

class KafkajsBatchConsumerPlugin extends ConsumerPlugin {
  static get id () {
    return 'kafkajs'
  }
  static get operation () {
    return 'consume-batch'
  }

  start ({ topic, partition, messages, groupId }) {
    const message = process.env.DD_EXPERIMENTAL_KAFKAJS_PLUGIN_TRACE_FIRST_BATCH_MESSAGE
      ? messages[0]
      : kafkaMessageStub

    if (this.config.dsmEnabled) {
      this.tracer.decodeDataStreamsContext(message.headers['dd-pathway-ctx'])
      this.tracer.setCheckpoint(['direction:in', `group:${groupId}`, `topic:${topic}`, 'type:kafka'])
    }
    const childOf = extract(this.tracer, message.headers)
    this.startSpan({
      childOf,
      resource: topic,
      type: 'worker',
      meta: {
        component: 'kafkajs',
        'kafka.topic': topic,
        'kafka.message.offset': messages[0].offset,
        'kafka.message.offsets': messages.map((m) => m.offset)
      },
      metrics: {
        'kafka.partition': partition,
        'kafka.batch_size': messages.length
      }
    })
  }
}

function extract (tracer, bufferMap) {
  if (!bufferMap) return null

  const textMap = {}

  for (const key of Object.keys(bufferMap)) {
    if (bufferMap[key] === null || bufferMap[key] === undefined) continue

    textMap[key] = bufferMap[key].toString()
  }

  return tracer.extract('text_map', textMap)
}

module.exports = KafkajsBatchConsumerPlugin
