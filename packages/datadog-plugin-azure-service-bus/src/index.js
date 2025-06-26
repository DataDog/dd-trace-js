'use strict'

const ProducerPlugin = require('./producer')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class AzureServiceBusPlugin extends CompositePlugin {
  static get id () { return 'azure-service-bus' }
  static get plugins () {
    return {
      producer: ProducerPlugin
    }
  }
}

module.exports = AzureServiceBusPlugin
