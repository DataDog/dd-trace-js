'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { storage } = require('../../datadog-core')

class ApolloGatewayGeneralPlugin extends TracingPlugin {
  static get id () { return 'apollo-gateway' }
  static get operation () { return 'general' }

  error (ctx) {
    const { span } = storage.getStore()
    span.setTag('error', ctx.error)
  }
}

module.exports = ApolloGatewayGeneralPlugin
