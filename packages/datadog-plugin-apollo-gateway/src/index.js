'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const ApolloGatewayExecutePlugin = require('./execute')
const ApolloGatewayPostProcessingPlugin = require('./postprocessing')
const ApolloGatewayRequestPlugin = require('./request')
const ApolloGatewayPlanPlugin = require('./plan')
const ApolloGatewayValidatePlugin = require('./validate')
const ApolloGatewayFetchPlugin = require('./fetch')
const ApolloGatewayGeneralPlugin = require('./general')

class ApolloGatewayPlugin extends CompositePlugin {
  static get id () { return 'apollo-gateway' }
  static get plugins () {
    return {
      execute: ApolloGatewayExecutePlugin,
      postprocessing: ApolloGatewayPostProcessingPlugin,
      request: ApolloGatewayRequestPlugin,
      plan: ApolloGatewayPlanPlugin,
      fetch: ApolloGatewayFetchPlugin,
      general: ApolloGatewayGeneralPlugin,
      validate: ApolloGatewayValidatePlugin
    }
  }
}

module.exports = ApolloGatewayPlugin
