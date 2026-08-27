'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
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
    operationName: () => 'amqp.receive',
    serviceName: integrationService('amqp'),
    serviceSource: integrationServiceSource('amqp'),
  },
  v1: {
    operationName: () => 'amqp.process',
    serviceName: identityService,
    serviceSource: noServiceSource,
  },
}

class Amqp10ConsumerPlugin extends ConsumerPlugin {
  static id = 'amqp10'
  static system = 'amqp'

  /** @override */
  getNamingSchema () {
    return namingSchema
  }

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
        'amqp.connection.user': address.user,
      },
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = Amqp10ConsumerPlugin
