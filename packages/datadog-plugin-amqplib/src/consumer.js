'use strict'

const { TEXT_MAP } = require('../../../ext/formats')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { getResourceName } = require('./util')

class AmqplibConsumerPlugin extends ConsumerPlugin {
  static get name () { return 'amqplib' }
  static get operation () { return 'command' }

  start ({ method, fields, message }) {
    if (method !== 'basic.deliver' && method !== 'basic.get') return

    const childOf = extract(this.tracer, message)

    this.startSpan('amqp.command', {
      childOf,
      service: this.config.service,
      resource: getResourceName(method, fields),
      kind: 'consumer',
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
  }
}

function extract (tracer, message) {
  return message
    ? tracer.extract(TEXT_MAP, message.properties.headers)
    : null
}

module.exports = AmqplibConsumerPlugin
