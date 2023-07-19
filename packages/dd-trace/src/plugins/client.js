'use strict'

const OutboundPlugin = require('./outbound')

class ClientPlugin extends OutboundPlugin {
  static get operation () { return 'request' }
  static get kind () { return 'client' }
  static get type () { return 'web' } // overridden by storage and other client type plugins
}

module.exports = ClientPlugin
