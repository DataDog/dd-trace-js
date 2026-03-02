'use strict'

const ApolloBasePlugin = require('../../../dd-trace/src/plugins/apollo')

class ApolloGatewayPlanPlugin extends ApolloBasePlugin {
  static operation = 'plan'
  static prefix = 'tracing:apm:apollo:gateway:plan'

  asyncStart (ctx) {
    const span = ctx?.currentStore?.span
    this.config.hooks.plan(span, ctx)

    return super.asyncStart(ctx)
  }
}

module.exports = ApolloGatewayPlanPlugin
