'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const { getAddress, getShortName } = require('./util')

class Amqp10ProducerPlugin extends ProducerPlugin {
  static get id () { return 'amqp10' }
  static get operation () { return 'send' }
  static get system () { return 'amqp' }

  start ({ link }) {
    const address = getAddress(link)
    const target = getShortName(link)

    this.startSpan({
      resource: ['send', target].filter(v => v).join(' '),
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
    })
  }
}

module.exports = Amqp10ProducerPlugin
