'use strict'

const ApolloBasePlugin = require('../../../dd-trace/src/plugins/apollo')

class ApolloGatewayPlanPlugin extends ApolloBasePlugin {
  static operation = 'plan'
  static prefix = 'tracing:apm:apollo:gateway:plan'

  onEnd (ctx) {
    const span = ctx?.currentStore?.span

    if (!span) return

    this.config.hooks.plan(span, ctx)
  }
}

module.exports = ApolloGatewayPlanPlugin
