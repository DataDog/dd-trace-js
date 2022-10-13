'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

class KafkajsProducerPlugin extends ProducerPlugin {
  static get name () { return 'kafkajs' }
  static get operation () { return 'produce' }

  start ({ topic, messages }) {
    const span = this.startSpan('kafka.produce', {
      service: this.config.service || `${this.tracer._service}-kafka`,
      resource: topic,
      kind: 'producer',
      meta: {
        'component': 'kafkajs',
        'kafka.topic': topic
      },
      metrics: {
        'kafka.batch_size': messages.length
      }
    })

    for (const message of messages) {
      if (typeof message === 'object') {
        this.tracer.inject(span, 'text_map', message.headers)
      }
    }
  }
}

module.exports = KafkajsProducerPlugin
