'use strict'

const OutgoingPlugin = require('./outgoing')

class ProducerPlugin extends OutgoingPlugin {
  static get operation () { return 'publish' }
  static get type () { return 'messaging' }
}

module.exports = ProducerPlugin
