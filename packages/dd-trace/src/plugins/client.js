'use strict'

const OutboundPlugin = require('./outbound')

class ClientPlugin extends OutboundPlugin {
  static operation = 'request'
  static kind = 'client'
  static type = 'web' // overridden by storage and other client type plugins
}

module.exports = ClientPlugin
