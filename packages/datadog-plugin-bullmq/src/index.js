'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const BullmqProducerPlugins = require('./producer')
const BullmqConsumerPlugin = require('./consumer')

class BullmqPlugin extends CompositePlugin {
  static id = 'bullmq'

  static plugins = {
    queueAdd: BullmqProducerPlugins[0],
    queueAddBulk: BullmqProducerPlugins[1],
    flowProducerAdd: BullmqProducerPlugins[2],
    consumer: BullmqConsumerPlugin,
  }
}

module.exports = BullmqPlugin
