'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

class BullmqProducerPlugin extends ProducerPlugin {
  static id = 'bullmq'
  static operation = 'produce'
}

module.exports = BullmqProducerPlugin
