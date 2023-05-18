'use strict'

const { TEXT_MAP } = require('../../../ext/formats')
const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { getResourceName } = require('./util')

class AmqplibProducerPlugin extends ProducerPlugin {
  static get id () { return 'amqplib' }
  static get operation () { return 'command' }

  start ({ channel = {}, method, fields }) {
    if (method !== 'basic.publish') return

    const stream = (channel.connection && channel.connection.stream) || {}
    const span = this.startSpan({
      resource: getResourceName(method, fields),
      meta: {
        'out.host': stream._host,
        [CLIENT_PORT_KEY]: stream.remotePort,
        'amqp.queue': fields.queue,
        'amqp.exchange': fields.exchange,
        'amqp.routingKey': fields.routingKey,
        'amqp.consumerTag': fields.consumerTag,
        'amqp.source': fields.source,
        'amqp.destination': fields.destination
      }
    })

    fields.headers = fields.headers || {}

    this.tracer.inject(span, TEXT_MAP, fields.headers)
  }
}

module.exports = AmqplibProducerPlugin
