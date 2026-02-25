'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')
const ClientPlugin = require('./client')

class GoogleCloudPubsubPlugin extends CompositePlugin {
  static id = 'google-cloud-pubsub'
  static get plugins () {
    return {
      producer: ProducerPlugin,
      consumer: ConsumerPlugin,
      client: ClientPlugin,
    }
  }
}

module.exports = GoogleCloudPubsubPlugin
