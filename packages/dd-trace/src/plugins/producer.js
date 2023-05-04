'use strict'

const OutgoingPlugin = require('./outgoing')

class ProducerPlugin extends OutgoingPlugin {
  static get operation () { return 'publish' }
}

module.exports = ProducerPlugin
