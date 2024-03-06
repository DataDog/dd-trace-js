'use strict'

const ApolloBasePlugin = require('../../../dd-trace/src/plugins/apollo')

class ApolloGatewayPlanPlugin extends ApolloBasePlugin {
  static get operation () { return 'plan' }
  static get prefix () {
    return 'tracing:apm:apollo:gateway:plan'
  }
}

module.exports = ApolloGatewayPlanPlugin
