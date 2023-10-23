'use strict'

const { getMessageSize, CONTEXT_PROPAGATION_KEY } = require('../../dd-trace/src/datastreams/processor')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')

class KafkajsConsumerPlugin extends ConsumerPlugin {
  static get id () { return 'kafkajs' }
  static get operation () { return 'consume' }

  constructor () {
    super(...arguments)
    this.addSub('apm:kafkajs:consume:commit', message => this.commit(message))
  }

  commit (commitList) {
    const keys = [
      'consumer_group',
      'type',
      'partition',
      'offset',
      'topic'
    ]
    if (!this.config.dsmEnabled) return
    // TODO log instead of returning
    for (const commit of commitList) {
      if (keys.some(key => !commit.hasOwnProperty(key))) return
      this.tracer.commitOffset(commit)
    }
  }

  start ({ topic, partition, message, groupId }) {
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
    if (this.config.dsmEnabled) {
      const payloadSize = getMessageSize(message)
      this.tracer.decodeDataStreamsContext(message.headers[CONTEXT_PROPAGATION_KEY])
      this.tracer
        .setCheckpoint(['direction:in', `group:${groupId}`, `topic:${topic}`, 'type:kafka'], span, payloadSize)
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
