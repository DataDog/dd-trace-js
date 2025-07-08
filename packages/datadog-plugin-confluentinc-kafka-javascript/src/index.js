'use strict'

const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')
const BatchConsumerPlugin = require('./batch-consumer')
const KafkajsPlugin = require('../../datadog-plugin-kafkajs/src/index')

class ConfluentKafkaJsPlugin extends KafkajsPlugin {
  static get id () { return 'confluentinc-kafka-javascript' }
  static get plugins () {
    return {
      producer: ProducerPlugin,
      consumer: ConsumerPlugin,
      batchConsumer: BatchConsumerPlugin
    }
  }
}

module.exports = ConfluentKafkaJsPlugin
