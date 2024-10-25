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

    if (result instanceof Array &&
      result[result.length - 1] && result[result.length - 1].stack && result[result.length - 1].message) {
      span.setTag('error', result[result.length - 1])
    }
    span.finish()
  }
}

module.exports = ApolloGatewayValidatePlugin
