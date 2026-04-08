'use strict'

const { TEXT_MAP } = require('../../../ext/formats')
const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const ClientPlugin = require('../../dd-trace/src/plugins/client')
const { getResourceName } = require('./util')

class AmqplibClientPlugin extends ClientPlugin {
  static id = 'amqplib'
  static type = 'messaging'
  static operation = 'command'

  bindStart (ctx) {
    const { channel = {}, method, fields } = ctx

    if (method === 'basic.deliver' || method === 'basic.get') return
    if (method === 'basic.publish') return

    const stream = (channel.connection && channel.connection.stream) || {}
    const snOpts = {}
    const service = this.config.service || this.serviceName(snOpts)
    const srvSrc = this.config.service
      ? (this.config.serviceFromMapping ? 'opt.mapping' : 'm')
      : snOpts.srvSrc

    const span = this.startSpan(this.operationName(), {
      service,
      srvSrc,
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
        'amqp.destination': fields.destination,
      },
    }, ctx)

    fields.headers = fields.headers || {}

    this.tracer.inject(span, TEXT_MAP, fields.headers)

    return ctx.currentStore
  }
}

module.exports = AmqplibClientPlugin
