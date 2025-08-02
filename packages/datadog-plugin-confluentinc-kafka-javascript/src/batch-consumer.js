'use strict'

const KafkajsBatchConsumerPlugin = require('../../datadog-plugin-kafkajs/src/batch-consumer')

class ConfluentKafkaJsBatchConsumerPlugin extends KafkajsBatchConsumerPlugin {
  static id = 'confluentinc-kafka-javascript'
}

module.exports = ConfluentKafkaJsBatchConsumerPlugin
