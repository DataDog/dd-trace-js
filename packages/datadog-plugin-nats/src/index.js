'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')

class NatsPlugin extends CompositePlugin {
  static id = 'nats'
  static get plugins () {
    return {
      producer: ProducerPlugin,
      consumer: ConsumerPlugin,
    }
  }
}

module.exports = NatsPlugin
