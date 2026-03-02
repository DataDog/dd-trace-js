'use strict'

const ApolloBasePlugin = require('../../../dd-trace/src/plugins/apollo')

class ApolloGatewayExecutePlugin extends ApolloBasePlugin {
  static operation = 'execute'
  static prefix = 'tracing:apm:apollo:gateway:execute'

  asyncStart (ctx) {
    const span = ctx?.currentStore?.span
    this.config.hooks.execute(span, ctx)

    return super.asyncStart(ctx)
  }
}

module.exports = ApolloGatewayExecutePlugin
