const ProducerPlugin = require('./producer')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class AzureEventHubsPlugin extends CompositePlugin {
  static get id () { return 'azure-event-hubs' }
  static get plugins () {
    return {
      producer: ProducerPlugin
    }
  }
}

module.exports = AzureEventHubsPlugin
