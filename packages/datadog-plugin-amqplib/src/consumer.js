'use strict'

const { TEXT_MAP } = require('../../../ext/formats')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { getAmqpMessageSize } = require('../../dd-trace/src/datastreams')
const { getResourceName } = require('./util')

class AmqplibConsumerPlugin extends ConsumerPlugin {
  static id = 'amqplib'
  static operation = 'consume'

  bindStart (ctx) {
    const { method, fields, message, queue } = ctx

    if (method !== 'basic.deliver' && method !== 'basic.get') return

    const childOf = extract(this.tracer, message)

    const queueName = queue || fields.queue || fields.routingKey
    const span = this.startSpan({
      childOf,
      resource: getResourceName(method, fields),
      type: 'worker',
      meta: {
        'amqp.queue': queueName,
        'amqp.exchange': fields.exchange,
        'amqp.routingKey': fields.routingKey,
        'amqp.consumerTag': fields.consumerTag,
        'amqp.source': fields.source,
        'amqp.destination': fields.destination
      }
    }, ctx)

    if (
      this.config.dsmEnabled && message?.properties?.headers
    ) {
      const payloadSize = getAmqpMessageSize({ headers: message.properties.headers, content: message.content })
      this.tracer.decodeDataStreamsContext(message.properties.headers)
      this.tracer
        .setCheckpoint(['direction:in', `topic:${queueName}`, 'type:rabbitmq'], span, payloadSize)
    }

    return ctx.currentStore
  }
}

function extract (tracer, message) {
  return message
    ? tracer.extract(TEXT_MAP, message.properties.headers)
    : null
}

module.exports = AmqplibConsumerPlugin
