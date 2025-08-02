'use strict'

const KafkajsProducerPlugin = require('../../datadog-plugin-kafkajs/src/producer')

class ConfluentKafkaJsProducerPlugin extends KafkajsProducerPlugin {
  static id = 'confluentinc-kafka-javascript'
}

module.exports = ConfluentKafkaJsProducerPlugin
