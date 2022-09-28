'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { getAddress, getShortName } = require('./util')

class Amqp10ConsumerPlugin extends ConsumerPlugin {
  static get name () { return 'amqp10' }

  start ({ link }) {
    const source = getShortName(link)
    const address = getAddress(link)

    this.startSpan('amqp.receive', {
      service: this.config.service,
      resource: ['receive', source].filter(v => v).join(' '),
      type: 'worker',
      kind: 'consumer',
      meta: {
        'amqp.link.source.address': source,
        'amqp.link.role': 'receiver',
        'amqp.link.name': link.name,
        'amqp.link.handle': link.handle,
        'amqp.connection.host': address.host,
        'amqp.connection.port': address.port,
        'amqp.connection.user': address.user
      }
    })
  }
}

module.exports = Amqp10ConsumerPlugin
