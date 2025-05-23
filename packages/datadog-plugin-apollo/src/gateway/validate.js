'use strict'

const ApolloBasePlugin = require('../../../dd-trace/src/plugins/apollo')

class ApolloGatewayValidatePlugin extends ApolloBasePlugin {
  static get operation () { return 'validate' }
  static get prefix () {
    return 'tracing:apm:apollo:gateway:validate'
  }

  end (ctx) {
    const result = ctx.result
    const span = ctx.currentStore?.span

    if (!span) return

    if (Array.isArray(result) && result.at(-1)?.stack && result.at(-1).message) {
      span.setTag('error', result.at(-1))
    }
    span.finish()
  }
}

module.exports = ApolloGatewayValidatePlugin
