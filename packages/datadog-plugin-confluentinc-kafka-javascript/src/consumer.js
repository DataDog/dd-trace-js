'use strict'

const KafkajsConsumerPlugin = require('../../datadog-plugin-kafkajs/src/consumer')

class ConfluentKafkaJsConsumerPlugin extends KafkajsConsumerPlugin {
  static id = 'confluentinc-kafka-javascript'
}

module.exports = ConfluentKafkaJsConsumerPlugin
