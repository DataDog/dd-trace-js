'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

class RheaProducerPlugin extends ProducerPlugin {
  static get name () { return 'rhea' }
  static get operation () { return 'send' }

  constructor (...args) {
    super(...args)

    this.addTraceSub('encode', this.encode.bind(this))
  }

  start ({ targetAddress, host, port }) {
    const name = targetAddress || 'amq.topic'

    this.startSpan('amqp.send', {
      service: this.config.service,
      resource: name,
      kind: 'producer',
      meta: {
        'component': 'rhea',
        'amqp.link.target.address': name,
        'amqp.link.role': 'sender',
        'out.host': host,
        'out.port': port
      }
    })
  }

  encode (msg) {
    addDeliveryAnnotations(msg, this.tracer, this.activeSpan())
  }
}

function addDeliveryAnnotations (msg, tracer, span) {
  if (msg) {
    msg.delivery_annotations = msg.delivery_annotations || {}

    tracer.inject(span, 'text_map', msg.delivery_annotations)
  }
}

module.exports = RheaProducerPlugin
