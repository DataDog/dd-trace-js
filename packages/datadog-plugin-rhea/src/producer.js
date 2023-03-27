'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const Naming = require('../../dd-trace/src/service-naming')

class RheaProducerPlugin extends ProducerPlugin {
  static get id () { return 'rhea' }
  static get operation () { return 'send' }

  constructor (...args) {
    super(...args)
    this.addTraceSub('encode', this.encode.bind(this))
  }

  start ({ targetAddress, host, port }) {
    const name = targetAddress || 'amq.topic'
    const naming = Naming.schema.messaging.outbound.rhea

    this.startSpan(naming.opName(), {
      service: this.config.service || naming.serviceName(this.tracer._service),
      resource: name,
      kind: 'producer',
      meta: {
        'component': 'rhea',
        'amqp.link.target.address': name,
        'amqp.link.role': 'sender',
        'out.host': host,
        [CLIENT_PORT_KEY]: port
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
