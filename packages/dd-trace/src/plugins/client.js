'use strict'

const TracingPlugin = require('./tracing')

class ClientPlugin extends TracingPlugin {
  // TODO: Exit span on finish when AsyncResource instances are removed.
}

module.exports = ClientPlugin
