'use strict'

const InboundPlugin = require('./inbound')

class ServerPlugin extends InboundPlugin {
  static operation = 'request'
  static kind = 'server'
  static type = 'web' // a default that may eventually be overriden by nonweb servers
}

module.exports = ServerPlugin
