'use strict'

const InboundPlugin = require('./inbound')

class ServerPlugin extends InboundPlugin {
  static get operation () { return 'request' }
}

module.exports = ServerPlugin
