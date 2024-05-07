'use strict'

const { TEXT_MAP } = require('../../../ext/formats')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { getAmqpMessageSize } = require('../../dd-trace/src/datastreams/processor')
const { DsmPathwayCodec } = require('../../dd-trace/src/datastreams/pathway')
const { getResourceName } = require('./util')

class AmqplibConsumerPlugin extends ConsumerPlugin {
  static get id () { return 'amqplib' }
  static get operation () { return 'command' }

  start ({ method, fields, message }) {
    if (method !== 'basic.deliver' && method !== 'basic.get') return

    const childOf = extract(this.tracer, message)

    const span = this.startSpan({
      childOf,
      resource: getResourceName(method, fields),
      type: 'worker',
      meta: {
        'amqp.queue': fields.queue,
        'amqp.exchange': fields.exchange,
        'amqp.routingKey': fields.routingKey,
        'amqp.consumerTag': fields.consumerTag,
        'amqp.source': fields.source,
        'amqp.destination': fields.destination
      }
    })

    if (
      this.config.dsmEnabled && message?.properties?.headers &&
      DsmPathwayCodec.contextExists(message.properties.headers)
    ) {
      const payloadSize = getAmqpMessageSize({ headers: message.properties.headers, content: message.content })
      const queue = fields.queue ? fields.queue : fields.routingKey
      this.tracer.decodeDataStreamsContext(message.properties.headers)
      this.tracer
        .setCheckpoint(['direction:in', `topic:${queue}`, 'type:rabbitmq'], span, payloadSize)
    }
  }
}

function extract (tracer, message) {
  return message
    ? tracer.extract(TEXT_MAP, message.properties.headers)
    : null
}

module.exports = AmqplibConsumerPlugin
