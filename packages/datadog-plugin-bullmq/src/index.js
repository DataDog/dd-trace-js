'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const producerPlugin = require('./producer')
const consumerPlugin = require('./consumer')

class BullmqPlugin extends CompositePlugin {
  static id = 'bullmq'
  static plugins = {
    producer: producerPlugin,
    consumer: consumerPlugin
  }
}

module.exports = BullmqPlugin
