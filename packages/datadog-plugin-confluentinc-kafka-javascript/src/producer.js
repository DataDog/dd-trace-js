'use strict'

const KafkajsProducerPlugin = require('../../datadog-plugin-kafkajs/src/producer')

class ConfluentKafkaJsProducerPlugin extends KafkajsProducerPlugin {
  static get id () {
    return 'confluentinc-kafka-javascript'
  }
}

module.exports = ConfluentKafkaJsProducerPlugin
