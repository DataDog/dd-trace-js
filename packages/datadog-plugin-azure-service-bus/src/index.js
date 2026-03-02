'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const ProducerPlugin = require('./producer')

class AzureServiceBusPlugin extends CompositePlugin {
  static get id () { return 'azure-service-bus' }
  static get plugins () {
    return {
      producer: ProducerPlugin,
    }
  }
}

module.exports = AzureServiceBusPlugin
