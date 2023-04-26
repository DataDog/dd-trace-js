'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

class RheaProducerPlugin extends ProducerPlugin {
  static get id () { return 'rhea' }
  static get operation () { return 'send' }

  constructor (...args) {
    super(...args)
    this.addTraceSub('encode', this.encode.bind(this))
  }

  start ({ targetAddress, host, port }) {
    const name = targetAddress || 'amq.topic'
    this.startSpan({
      resource: name,
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
