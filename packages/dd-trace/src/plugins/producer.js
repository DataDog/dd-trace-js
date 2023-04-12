'use strict'

const OutboundPlugin = require('./outbound')

class ProducerPlugin extends OutboundPlugin {
  static get operation () { return 'publish' }
  static get type () { return 'messaging' }
}

module.exports = ProducerPlugin
