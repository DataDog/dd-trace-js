'use strict'

const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')
const ClientPlugin = require('./client')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

// TODO: Consider splitting channels for publish/receive in the instrumentation.
class GoogleCloudPubsubPlugin extends CompositePlugin {
  static get name () { return 'google-cloud-pubsub' }
  static get plugins () {
    return {
      producer: ProducerPlugin,
      consumer: ConsumerPlugin,
      client: ClientPlugin
    }
  }
}

module.exports = GoogleCloudPubsubPlugin
