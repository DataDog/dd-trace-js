'use strict'

const ApolloBasePlugin = require('../../../dd-trace/src/plugins/apollo')

class ApolloGatewayExecutePlugin extends ApolloBasePlugin {
  static operation = 'execute'
  static prefix = 'tracing:apm:apollo:gateway:execute'

  onAsyncStart (ctx) {
    const span = ctx?.currentStore?.span

    if (!span) return

    this.config.hooks.execute(span, ctx)
  }
}

module.exports = ApolloGatewayExecutePlugin
