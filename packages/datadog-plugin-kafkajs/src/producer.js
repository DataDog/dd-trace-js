'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { encodePathwayContext } = require('../../dd-trace/src/datastreams/pathway')

class KafkajsProducerPlugin extends ProducerPlugin {
  static get id () { return 'kafkajs' }
  static get operation () { return 'produce' }

  start ({ topic, messages }) {
    // TODO: extract this block to the base class when we support more queue products
    let pathwayCtx
    if (this.config.dsmEnabled) {
      const dataStreamsContext = this.tracer
        .setCheckpoint(['direction:out', `topic:${topic}`, 'type:kafka'])
      pathwayCtx = encodePathwayContext(dataStreamsContext)
    }
    const span = this.startSpan('kafka.produce', {
      resource: topic,
      meta: {
        'component': 'kafkajs',
        'kafka.topic': topic
      },
      metrics: {
        'kafka.batch_size': messages.length
      }
    })
    // TODO: extract this block to the base class when we support more queue products
    for (const message of messages) {
      if (typeof message === 'object') {
        if (this.config.dsmEnabled) message.headers['dd-pathway-ctx'] = pathwayCtx
        this.tracer.inject(span, 'text_map', message.headers)
      }
    }
  }
}

module.exports = KafkajsProducerPlugin
