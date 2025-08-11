'use strict'

const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')
const HttpHandlerPlugin = require('./http-handler')
const ClientPlugin = require('./client')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

// TODO: Consider splitting channels for publish/receive in the instrumentation.
class GoogleCloudPubsubPlugin extends CompositePlugin {
  static id = 'google-cloud-pubsub'
  static get plugins () {
    return {
      producer: ProducerPlugin,
      consumer: ConsumerPlugin,
      'http-handler': HttpHandlerPlugin,
      client: ClientPlugin
    }
  }
}

module.exports = GoogleCloudPubsubPlugin
