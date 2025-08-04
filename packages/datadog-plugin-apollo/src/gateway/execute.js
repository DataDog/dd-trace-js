'use strict'

const ApolloBasePlugin = require('../../../dd-trace/src/plugins/apollo')

class ApolloGatewayExecutePlugin extends ApolloBasePlugin {
  static operation = 'execute'
  static prefix = 'tracing:apm:apollo:gateway:execute'
}

module.exports = ApolloGatewayExecutePlugin
