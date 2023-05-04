'use strict'

const IncomingPlugin = require('./incoming')

class ServerPlugin extends IncomingPlugin {
  static get operation () { return 'request' }
}

module.exports = ServerPlugin
