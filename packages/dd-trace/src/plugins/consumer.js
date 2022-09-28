'use strict'

const OutgoingPlugin = require('./outgoing')

class ConsumerPlugin extends OutgoingPlugin {
  static get operation () { return 'consumer' }
}

module.exports = ConsumerPlugin
