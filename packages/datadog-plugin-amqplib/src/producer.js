'use strict'

const { TEXT_MAP } = require('../../../ext/formats')
const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { DsmPathwayCodec } = require('../../dd-trace/src/datastreams/pathway')
const { getAmqpMessageSize } = require('../../dd-trace/src/datastreams/processor')
const { getResourceName } = require('./util')

class AmqplibProducerPlugin extends ProducerPlugin {
  static get id () { return 'amqplib' }
  static get operation () { return 'command' }

  start ({ channel = {}, method, fields, message }) {
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

    if (this.config.dsmEnabled) {
      const hasRoutingKey = fields.routingKey != null
      const payloadSize = getAmqpMessageSize({ content: message, headers: fields.headers })
      const dataStreamsContext = this.tracer
        .setCheckpoint(
          ['direction:out', `exchange:${fields.exchange}`, `has_routing_key:${hasRoutingKey}`, 'type:rabbitmq']
          , span, payloadSize)
      DsmPathwayCodec.encode(dataStreamsContext, fields.headers)
    }
  }
}

module.exports = AmqplibProducerPlugin
