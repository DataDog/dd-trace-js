'use strict'

const OutgoingPlugin = require('./outgoing')

class ConsumerPlugin extends OutgoingPlugin {
  static operation = 'receive'
}

module.exports = ConsumerPlugin
