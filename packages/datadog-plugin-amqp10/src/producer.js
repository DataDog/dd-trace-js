'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { getAddress, getShortName } = require('./util')

class Amqp10ProducerPlugin extends ProducerPlugin {
  static get name () { return 'amqp10' }
  static get operation () { return 'send' }
  static get system () { return 'amqp' }

  start ({ link }) {
    const address = getAddress(link)
    const target = getShortName(link)

    this.startSpan('amqp.send', {
      service: this.config.service || `${this.tracer._service}-amqp`,
      resource: ['send', target].filter(v => v).join(' '),
      kind: 'producer',
      meta: {
        'amqp.link.target.address': target,
        'amqp.link.role': 'sender',
        'out.host': address.host,
        'out.port': address.port,
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
