'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { getAddress, getShortName } = require('./util')

class Amqp10ConsumerPlugin extends ConsumerPlugin {
  static get id () { return 'amqp10' }
  static get system () { return 'amqp' }

  bindStart (ctx) {
    const { link } = ctx

    const source = getShortName(link)
    const address = getAddress(link)

    this.startSpan({
      resource: ['receive', source].filter(Boolean).join(' '),
      type: 'worker',
      meta: {
        'amqp.link.source.address': source,
        'amqp.link.role': 'receiver',
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

module.exports = Amqp10ConsumerPlugin
