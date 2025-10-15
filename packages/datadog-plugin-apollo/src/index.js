'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const ApolloGatewayPlugin = require('./gateway')

class ApolloPlugin extends CompositePlugin {
  static id = 'apollo'
  static get plugins () {
    return {
      gateway: ApolloGatewayPlugin
    }
  }
}

module.exports = ApolloPlugin
