'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const producerPlugin = require('./producer')
const consumerPlugin = require('./consumer')

class BeeQueuePlugin extends CompositePlugin {
  static id = 'bee-queue'
  static plugins = {
    ...producerPlugin,
    consumer: consumerPlugin
  }
}

module.exports = BeeQueuePlugin
