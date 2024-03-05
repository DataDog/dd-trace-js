'use strict'

const ApolloBasePlugin = require('../../../dd-trace/src/plugins/apollo')

class ApolloGatewayPostProcessingPlugin extends ApolloBasePlugin {
  static get operation () { return 'postprocessing' }
  static get prefix () {
    return 'tracing:apm:apollo:gateway:postprocessing'
  }
}

module.exports = ApolloGatewayPostProcessingPlugin
