'use strict'

const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')
const ClientPlugin = require('./client')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class GoogleCloudPubsubPlugin extends CompositePlugin {
  static id = 'google-cloud-pubsub'
  static get plugins () {
    return {
      producer: ProducerPlugin,
      consumer: ConsumerPlugin,
      client: ClientPlugin
    }
  }
}

module.exports = GoogleCloudPubsubPlugin
