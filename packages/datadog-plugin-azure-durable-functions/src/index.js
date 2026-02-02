'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const AzureDurableFunctionsOutboundPlugin = require('./outbound')

class AzureDurableFunctionsPlugin extends CompositePlugin {
  static get id () {
    return 'azure-durable-functions'
  }

  // static get prefix () {
  //   return 'tracing:apm:azure-durable-functions'
  // }

  static get plugins () {
    return {
      outbound: AzureDurableFunctionsOutboundPlugin,
    }
  }
}

module.exports = AzureDurableFunctionsPlugin
