'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const { getAddress, getShortName } = require('./util')

class Amqp10ProducerPlugin extends ProducerPlugin {
  static get id () { return 'amqp10' }
  static get operation () { return 'send' }
  static get system () { return 'amqp' }

  bindStart (ctx) {
    const { link } = ctx

    const address = getAddress(link)
    const target = getShortName(link)

    this.startSpan({
      resource: ['send', target].filter(Boolean).join(' '),
      meta: {
        'amqp.link.target.address': target,
        'amqp.link.role': 'sender',
        'out.host': address.host,
        [CLIENT_PORT_KEY]: address.port,
        'amqp.link.name': link.name,
        'amqp.link.handle': link.handle,
        'amqp.connection.host': address.host,
        'amqp.connection.port': address.port,
        'amqp.connection.user': address.user
      }
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = Amqp10ProducerPlugin
