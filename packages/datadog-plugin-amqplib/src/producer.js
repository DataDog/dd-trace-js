'use strict'

const { TEXT_MAP } = require('../../../ext/formats')
const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { DsmPathwayCodec, getAmqpMessageSize } = require('../../dd-trace/src/datastreams')
const {
  identityService,
  integrationService,
  integrationServiceSource,
  noServiceSource,
} = require('../../dd-trace/src/service-naming/helpers')
const { getResourceName } = require('./util')

/** @type {import('../../dd-trace/src/plugins/tracing').NamingSchema} */
const namingSchema = {
  v0: {
    operationName: () => 'amqp.command',
    serviceName: integrationService('amqp'),
    serviceSource: integrationServiceSource('amqp'),
  },
  v1: {
    operationName: () => 'amqp.send',
    serviceName: identityService,
    serviceSource: noServiceSource,
  },
}

class AmqplibProducerPlugin extends ProducerPlugin {
  static id = 'amqplib'
  static operation = 'publish'

  /** @override */
  getNamingSchema () {
    return namingSchema
  }

  start (ctx) {
    if (!this.config.dsmEnabled) return
    const { fields, message } = ctx
    const { span } = ctx.currentStore

    const hasRoutingKey = fields.routingKey != null
    const payloadSize = getAmqpMessageSize({ content: message, headers: fields.headers })

    // there are two ways to send messages in RabbitMQ:
    // 1. using an exchange and a routing key in which DSM connects via the exchange
    // 2. using an unnamed exchange and a routing key in which DSM connects via the topic
    const exchangeOrTopicTag = hasRoutingKey && !fields.exchange
      ? `topic:${fields.routingKey}`
      : `exchange:${fields.exchange}`

    const dataStreamsContext = this.tracer.setCheckpoint(
      ['direction:out', exchangeOrTopicTag, `has_routing_key:${hasRoutingKey}`, 'type:rabbitmq'],
      span, payloadSize
    )
    DsmPathwayCodec.encode(dataStreamsContext, fields.headers)
  }

  bindStart (ctx) {
    const { channel = {}, method, fields } = ctx

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
        'amqp.destination': fields.destination,
      },
    }, ctx)

    fields.headers ||= {}

    this.tracer.inject(span, TEXT_MAP, fields.headers)

    return ctx.currentStore
  }
}

module.exports = AmqplibProducerPlugin
