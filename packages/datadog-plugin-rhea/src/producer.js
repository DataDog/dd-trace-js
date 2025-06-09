'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { getAmqpMessageSize, DsmPathwayCodec } = require('../../dd-trace/src/datastreams')

class RheaProducerPlugin extends ProducerPlugin {
  static get id () { return 'rhea' }
  static get operation () { return 'send' }

  constructor (...args) {
    super(...args)
    this.addTraceSub('encode', this.encode.bind(this))
  }

  bindStart (ctx) {
    const { targetAddress, host, port } = ctx
    const name = targetAddress || 'amq.topic'
    this.startSpan({
      resource: name,
      meta: {
        component: 'rhea',
        'amqp.link.target.address': name,
        'amqp.link.role': 'sender',
        'out.host': host,
        [CLIENT_PORT_KEY]: port
      }
    }, ctx)

    return ctx.currentStore
  }

  encode (msg) {
    addDeliveryAnnotations(msg, this.tracer, this.activeSpan)
  }
}

function addDeliveryAnnotations (msg, tracer, span) {
  if (msg) {
    msg.delivery_annotations = msg.delivery_annotations || {}

    tracer.inject(span, 'text_map', msg.delivery_annotations)

    if (tracer._config.dsmEnabled) {
      const targetName = span.context()._tags['amqp.link.target.address']
      const payloadSize = getAmqpMessageSize({ content: msg.body, headers: msg.delivery_annotations })
      const dataStreamsContext = tracer
        .setCheckpoint(['direction:out', `exchange:${targetName}`, 'type:rabbitmq'], span, payloadSize)
      DsmPathwayCodec.encode(dataStreamsContext, msg.delivery_annotations)
    }
  }
}

module.exports = RheaProducerPlugin
