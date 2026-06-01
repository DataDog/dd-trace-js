'use strict'

const ApolloBasePlugin = require('../../../dd-trace/src/plugins/apollo')

class ApolloGatewayPostProcessingPlugin extends ApolloBasePlugin {
  static operation = 'postprocessing'
  static prefix = 'tracing:apm:apollo:gateway:postprocessing'

  onAsyncStart (ctx) {
    const span = ctx?.currentStore?.span
    this.config.hooks.postprocessing(span, ctx)
  }
}

module.exports = ApolloGatewayPostProcessingPlugin
