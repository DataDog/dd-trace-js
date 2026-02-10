'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const ProducerPlugin = require('./producer')

class AzureEventHubsPlugin extends CompositePlugin {
  static get id () { return 'azure-event-hubs' }
  static get plugins () {
    return {
      producer: ProducerPlugin,
    }
  }
}

module.exports = AzureEventHubsPlugin
