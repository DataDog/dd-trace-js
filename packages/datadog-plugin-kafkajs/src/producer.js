'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { encodePathwayContext } = require('../../dd-trace/src/datastreams/pathway')
const { getMessageSize, CONTEXT_PROPAGATION_KEY } = require('../../dd-trace/src/datastreams/processor')

const BOOTSTRAP_SERVERS_KEY = 'messaging.kafka.bootstrap.servers'

class KafkajsProducerPlugin extends ProducerPlugin {
  static get id () { return 'kafkajs' }
  static get operation () { return 'produce' }
  static get peerServicePrecursors () { return [BOOTSTRAP_SERVERS_KEY] }

  start ({ topic, messages, bootstrapServers }) {
    let pathwayCtx
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
        this.tracer.inject(span, 'text_map', message.headers)
        if (this.config.dsmEnabled) {
          const payloadSize = getMessageSize(message)
          const dataStreamsContext = this.tracer
            .setCheckpoint(['direction:out', `topic:${topic}`, 'type:kafka'], span, payloadSize)
          pathwayCtx = encodePathwayContext(dataStreamsContext)
          message.headers[CONTEXT_PROPAGATION_KEY] = pathwayCtx
        }
      }
    }
  }
}

module.exports = KafkajsProducerPlugin
