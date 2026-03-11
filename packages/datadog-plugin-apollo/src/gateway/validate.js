'use strict'

const ApolloBasePlugin = require('../../../dd-trace/src/plugins/apollo')

class ApolloGatewayValidatePlugin extends ApolloBasePlugin {
  static operation = 'validate'
  static prefix = 'tracing:apm:apollo:gateway:validate'

  onEnd (ctx) {
    const result = ctx.result
    const span = ctx?.currentStore?.span

    if (!span) return

    if (Array.isArray(result) && result.at(-1)?.stack && result.at(-1).message) {
      span.setTag('error', result.at(-1))
    }

    this.config.hooks.validate(span, ctx)
  }
}

module.exports = ApolloGatewayValidatePlugin
