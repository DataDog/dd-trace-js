'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const {
  identityService,
  integrationService,
  integrationServiceSource,
  noServiceSource,
} = require('../../dd-trace/src/service-naming/helpers')
const { getAddress, getShortName } = require('./util')

/** @type {import('../../dd-trace/src/plugins/tracing').NamingSchema} */
const namingSchema = {
  v0: {
    operationName: () => 'amqp.send',
    serviceName: integrationService('amqp'),
    serviceSource: integrationServiceSource('amqp'),
  },
  v1: {
    operationName: () => 'amqp.send',
    serviceName: identityService,
    serviceSource: noServiceSource,
  },
}

class Amqp10ProducerPlugin extends ProducerPlugin {
  static id = 'amqp10'
  static operation = 'send'
  static system = 'amqp'

  /** @override */
  getNamingSchema () {
    return namingSchema
  }

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
        'amqp.connection.user': address.user,
      },
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = Amqp10ProducerPlugin
