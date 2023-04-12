'use strict'

const OutboundPlugin = require('./outbound')

class ClientPlugin extends OutboundPlugin {
  static get operation () { return 'request' }
}

module.exports = ClientPlugin
