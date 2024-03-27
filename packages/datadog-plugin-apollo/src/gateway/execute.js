'use strict'

const ApolloBasePlugin = require('../../../dd-trace/src/plugins/apollo')

class ApolloGatewayExecutePlugin extends ApolloBasePlugin {
  static get operation () { return 'execute' }
  static get prefix () {
    return 'tracing:apm:apollo:gateway:execute'
  }
}

module.exports = ApolloGatewayExecutePlugin
