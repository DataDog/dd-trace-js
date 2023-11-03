'use strict'

const { getMessageSize, CONTEXT_PROPAGATION_KEY } = require('../../dd-trace/src/datastreams/processor')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { PATHWAY_HASH } = require('../../../ext/tags')

class KafkajsConsumerPlugin extends ConsumerPlugin {
  static get id () { return 'kafkajs' }
  static get operation () { return 'consume' }

  start ({ topic, partition, message, groupId }) {
    let dataStreamsContext
    if (this.config.dsmEnabled) {
      const payloadSize = getMessageSize(message)
      dataStreamsContext = this.tracer.decodeDataStreamsContext(message.headers[CONTEXT_PROPAGATION_KEY])
      this.tracer
        .setCheckpoint(['direction:in', `group:${groupId}`, `topic:${topic}`, 'type:kafka'], payloadSize)
    }
    const childOf = extract(this.tracer, message.headers)
    const span = this.startSpan({
      childOf,
      resource: topic,
      type: 'worker',
      meta: {
        'component': 'kafkajs',
        'kafka.topic': topic,
        'kafka.message.offset': message.offset
      },
      metrics: {
        'kafka.partition': partition
      }
    })
    // set DSM pathway hash to enable related traces feature on DSM tab
    if (dataStreamsContext.hash) {
      span.setTag(PATHWAY_HASH, dataStreamsContext.hash)
    }
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

module.exports = KafkajsConsumerPlugin
