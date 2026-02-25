'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')
const BatchConsumerPlugin = require('./batch-consumer')

class KafkajsPlugin extends CompositePlugin {
  static id = 'kafkajs'
  static get plugins () {
    return {
      producer: ProducerPlugin,
      consumer: ConsumerPlugin,
      batchConsumer: BatchConsumerPlugin,
    }
  }
}

module.exports = KafkajsPlugin
