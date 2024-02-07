'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const log = require('../../dd-trace/src/log')
const ApolloGatewayExecutePlugin = require('./execute')
const ApolloGatewayPostProcessingPlugin = require('./postprocessing')

class ApolloGatewayPlugin extends CompositePlugin {
  static get id () { return 'apollo' }
  static get plugins () {
    return {
      execute: ApolloGatewayExecutePlugin,
      postprocessing: ApolloGatewayPostProcessingPlugin
    }
  }
}

module.exports = ApolloGatewayPlugin
