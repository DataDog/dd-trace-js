'use strict'

const ApolloBasePlugin = require('../../../dd-trace/src/plugins/apollo')

class ApolloGatewayPlanPlugin extends ApolloBasePlugin {
  static operation = 'plan'
  static prefix = 'tracing:apm:apollo:gateway:plan'
}

module.exports = ApolloGatewayPlanPlugin
