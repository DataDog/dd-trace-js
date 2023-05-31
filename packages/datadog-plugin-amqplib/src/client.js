'use strict'

const { TEXT_MAP } = require('../../../ext/formats')
const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const ClientPlugin = require('../../dd-trace/src/plugins/client')
const { getResourceName } = require('./util')

class AmqplibClientPlugin extends ClientPlugin {
  static get id () { return 'amqplib' }
  static get type () { return 'messaging' }
  static get operation () { return 'command' }

  start ({ channel = {}, method, fields }) {
    if (method === 'basic.deliver' || method === 'basic.get') return
    if (method === 'basic.publish') return

    const stream = (channel.connection && channel.connection.stream) || {}
    const span = this.startSpan(this.operationName(), {
      service: this.config.service || this.serviceName(),
      resource: getResourceName(method, fields),
      kind: this.constructor.kind,
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

module.exports = AmqplibClientPlugin
