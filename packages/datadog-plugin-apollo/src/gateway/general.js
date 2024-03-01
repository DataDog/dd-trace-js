'use strict'

const TracingPlugin = require('../../../dd-trace/src/plugins/tracing')
const { storage } = require('../../../datadog-core')

class ApolloGatewayGeneralPlugin extends TracingPlugin {
  static get id () { return 'apollo.gateway' }
  static get operation () { return 'general' }

  static get prefix () {
    return 'apm:apollo:gateway:general'
  }

  error (ctx) {
    const store = storage.getStore()
    const span = store?.span
    if (!span) return
    span.setTag('error', ctx.error)
  }
}

module.exports = ApolloGatewayGeneralPlugin
