'use strict'

const ApolloBasePlugin = require('../../../dd-trace/src/plugins/apollo')

class ApolloGatewayPostProcessingPlugin extends ApolloBasePlugin {
  static operation = 'postprocessing'
  static prefix = 'tracing:apm:apollo:gateway:postprocessing'
}

module.exports = ApolloGatewayPostProcessingPlugin
