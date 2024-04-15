'use strict'

const { storage } = require('../../../datadog-core')
const CompositePlugin = require('../../../dd-trace/src/plugins/composite')
const ApolloGatewayExecutePlugin = require('./execute')
const ApolloGatewayPostProcessingPlugin = require('./postprocessing')
const ApolloGatewayRequestPlugin = require('./request')
const ApolloGatewayPlanPlugin = require('./plan')
const ApolloGatewayValidatePlugin = require('./validate')
const ApolloGatewayFetchPlugin = require('./fetch')

class ApolloGatewayPlugin extends CompositePlugin {
  static get id () { return 'gateway' }
  static get plugins () {
    return {
      execute: ApolloGatewayExecutePlugin,
      postprocessing: ApolloGatewayPostProcessingPlugin,
      request: ApolloGatewayRequestPlugin,
      plan: ApolloGatewayPlanPlugin,
      fetch: ApolloGatewayFetchPlugin,
      validate: ApolloGatewayValidatePlugin
    }
  }

  constructor (...args) {
    super(...args)
    this.addSub('apm:apollo:gateway:general:error', (ctx) => {
      const store = storage.getStore()
      const span = store?.span
      if (!span) return
      span.setTag('error', ctx.error)
    })
  }
}

module.exports = ApolloGatewayPlugin
