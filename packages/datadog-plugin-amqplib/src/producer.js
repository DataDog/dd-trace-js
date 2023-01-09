'use strict'

const { TEXT_MAP } = require('../../../ext/formats')
const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { getResourceName } = require('./util')
const { resolveHostDetails } = require('../../dd-trace/src/util')

class AmqplibProducerPlugin extends ProducerPlugin {
  static get name () { return 'amqplib' }
  static get operation () { return 'command' }

  start ({ channel = {}, method, fields }) {
    if (method !== 'basic.publish') return

    const stream = (channel.connection && channel.connection.stream) || {}

    const hostDetails = resolveHostDetails(stream._host)

    const span = this.startSpan('amqp.command', {
      service: this.config.service || `${this.tracer._service}-amqp`,
      resource: getResourceName(method, fields),
      kind: 'producer',
      meta: {
        ...hostDetails,
        'network.destination.port': stream.remotePort,
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
