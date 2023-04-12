'use strict'

const TracingPlugin = require('./tracing')

class InboundPlugin extends TracingPlugin {
  static get ioDirection () { return 'inbound' }
}

module.exports = InboundPlugin
