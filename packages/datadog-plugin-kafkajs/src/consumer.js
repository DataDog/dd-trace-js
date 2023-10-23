'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')

class KafkajsConsumerPlugin extends ConsumerPlugin {
  static get id () { return 'kafkajs' }
  static get operation () { return 'consume' }

  constructor () {
    super(...arguments)
    this.addSub('apm:kafkajs:consume:commit', this.commit)
  }

  commit (offsetData) {
    const keys = [
      'consumer_group',
      'type',
      'partition',
      'offset',
      'topic'
    ]

    if (!this.config.dsmEnabled) return

    // TODO log instead of returning
    if (keys.some(key => !offsetData.hasOwnProperty(key))) return

    console.log(`metric ${JSON.stringify(offsetData)}`)
    return this.tracer.commitOffset(offsetData)
  }

  start ({ topic, partition, message, groupId }) {
    if (this.config.dsmEnabled) {
      this.tracer.decodeDataStreamsContext(message.headers['dd-pathway-ctx'])
      this.tracer
        .setCheckpoint(['direction:in', `group:${groupId}`, `topic:${topic}`, 'type:kafka'])
    }
    const childOf = extract(this.tracer, message.headers)
    this.startSpan({
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
