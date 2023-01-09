'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { resolveHostDetails } = require('../../dd-trace/src/util')

class RheaProducerPlugin extends ProducerPlugin {
  static get name () { return 'rhea' }
  static get operation () { return 'send' }

  constructor (...args) {
    super(...args)

    this.addTraceSub('encode', this.encode.bind(this))
  }

  start ({ targetAddress, host, port }) {
    const name = targetAddress || 'amq.topic'

    const destinationHostDetails = resolveHostDetails(host)

    this.startSpan('amqp.send', {
      service: this.config.service || `${this.tracer._service}-amqp-producer`,
      resource: name,
      kind: 'producer',
      meta: {
        'component': 'rhea',
        'amqp.link.target.address': name,
        'amqp.link.role': 'sender',
        'network.destination.port': port,
        ...destinationHostDetails
      }
    })
  }

  encode (msg) {
    addDeliveryAnnotations(msg, this.tracer, this.activeSpan)
  }
}

function addDeliveryAnnotations (msg, tracer, span) {
  if (msg) {
    msg.delivery_annotations = msg.delivery_annotations || {}

    tracer.inject(span, 'text_map', msg.delivery_annotations)
  }
}

module.exports = RheaProducerPlugin
