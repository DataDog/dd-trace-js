'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')

class BullmqConsumerPlugin extends ConsumerPlugin {
  static id = 'bullmq'
  static operation = 'receive'
}

module.exports = BullmqConsumerPlugin
