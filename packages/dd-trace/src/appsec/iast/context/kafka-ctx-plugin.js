'use strict'

const { KAFKA_MESSAGE_KEY, KAFKA_MESSAGE_VALUE } = require('../taint-tracking/source-types')
const IastContextPlugin = require('./context-plugin')

class KafkaContextPlugin extends IastContextPlugin {
  onConfigure () {
    this.startCtxOn('dd-trace:kafkajs:consumer:afterStart', [KAFKA_MESSAGE_KEY, KAFKA_MESSAGE_VALUE])

    this.finishCtxOn('dd-trace:kafkajs:consumer:beforeFinish')
  }
}

module.exports = new KafkaContextPlugin()
