'use strict'

const { KAFKA_KEY, KAFKA_VALUE } = require('../taint-tracking/source-types')
const IastContextPlugin = require('./context-plugin')

class KafkaContextPlugin extends IastContextPlugin {
  onConfigure () {
    this.startCtxOn('dd-trace:kafkajs:consumer:start', [KAFKA_KEY, KAFKA_VALUE])

    this.finishCtxOn('dd-trace:kafkajs:consumer:finish')
  }
}

module.exports = new KafkaContextPlugin()
