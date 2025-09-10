'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')

const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')

class BullmqPlugin extends CompositePlugin {
  static id = 'bullmq'
  static get plugins () {
    return {
      producer: ProducerPlugin,
      consumer: ConsumerPlugin
    }
  }
}

module.exports = BullmqPlugin
