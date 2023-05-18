'use strict'

const OutboundPlugin = require('./outbound')

class ClientPlugin extends OutboundPlugin {
  static get operation () { return 'request' }
  static get kind () { return 'client' }
}

module.exports = ClientPlugin
