'use strict'

const OutgoingPlugin = require('./outgoing')

class ClientPlugin extends OutgoingPlugin {
  static get operation () { return 'request' }
}

module.exports = ClientPlugin
