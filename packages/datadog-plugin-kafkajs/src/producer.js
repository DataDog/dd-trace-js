'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { encodePathwayContext } = require('../../dd-trace/src/datastreams/pathway')
const { calculateByteSize, CONTEXT_PROPAGATION_KEY } = require('../../dd-trace/src/datastreams/processor')

const BOOTSTRAP_SERVERS_KEY = 'messaging.kafka.bootstrap.servers'

class KafkajsProducerPlugin extends ProducerPlugin {
  static get id () { return 'kafkajs' }
  static get operation () { return 'produce' }
  static get peerServicePrecursors () { return [BOOTSTRAP_SERVERS_KEY] }

  start ({ topic, messages, bootstrapServers }) {
    let pathwayCtx
    if (this.config.dsmEnabled) {
      let payloadSize = 0
      for (const message of messages) {
        payloadSize += calculateByteSize(message.key)
        payloadSize += calculateByteSize(message.value)
        payloadSize += calculateByteSize(message.headers)
      }
      const dataStreamsContext = this.tracer
        .setCheckpoint(['direction:out', `topic:${topic}`, 'type:kafka'], payloadSize)
      pathwayCtx = encodePathwayContext(dataStreamsContext)
    }
    const span = this.startSpan({
      resource: topic,
      meta: {
        'component': 'kafkajs',
        'kafka.topic': topic
      },
      metrics: {
        'kafka.batch_size': messages.length
      }
    })
    if (bootstrapServers) {
      span.setTag(BOOTSTRAP_SERVERS_KEY, bootstrapServers)
    }
    for (const message of messages) {
      if (typeof message === 'object') {
        if (this.config.dsmEnabled) message.headers[CONTEXT_PROPAGATION_KEY] = pathwayCtx
        this.tracer.inject(span, 'text_map', message.headers)
      }
    }
  }
}

module.exports = KafkajsProducerPlugin
