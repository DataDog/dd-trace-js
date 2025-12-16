'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const NatsProducerPlugin = require('./producer')
const NatsConsumerPlugin = require('./consumer')

class NatsPlugin extends CompositePlugin {
  static get id () {
    return 'nats'
  }

  static get plugins () {
    return {
      producer: NatsProducerPlugin,
      consumer: NatsConsumerPlugin
    }
  }
}

module.exports = NatsPlugin
