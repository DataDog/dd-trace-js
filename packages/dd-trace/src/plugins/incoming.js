'use strict'

const TracingPlugin = require('./tracing')

class IncomingPlugin extends TracingPlugin {
  static get ioDirection () { return 'inbound' }
}

module.exports = IncomingPlugin
