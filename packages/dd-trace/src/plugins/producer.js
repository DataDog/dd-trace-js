'use strict'

const OutgoingPlugin = require('./outgoing')

class ProducerPlugin extends OutgoingPlugin {
  static operation = 'publish'
}

module.exports = ProducerPlugin
