'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { getAmqpMessageSize, DsmPathwayCodec } = require('../../dd-trace/src/datastreams')
const { storage } = require('../../datadog-core')

class RheaProducerPlugin extends ProducerPlugin {
  static id = 'rhea'
  static operation = 'send'

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
        [CLIENT_PORT_KEY]: port,
      },
    }, ctx)
    ctx.currentStore.rheaTargetName = name

    return ctx.currentStore
  }

  encode (msg) {
    const store = storage('legacy').getStore()
    addDeliveryAnnotations(msg, this.tracer, store?.span, store?.rheaTargetName)
  }
}

function addDeliveryAnnotations (msg, tracer, span, targetName) {
  if (msg) {
    msg.delivery_annotations ||= {}

    tracer.inject(span, 'text_map', msg.delivery_annotations)

    if (tracer._config.dsmEnabled) {
      const payloadSize = getAmqpMessageSize({ content: msg.body, headers: msg.delivery_annotations })
      const dataStreamsContext = tracer
        .setCheckpoint(['direction:out', `exchange:${targetName}`, 'type:rabbitmq'], span, payloadSize)
      DsmPathwayCodec.encode(dataStreamsContext, msg.delivery_annotations)
    }
  }
}

module.exports = RheaProducerPlugin
