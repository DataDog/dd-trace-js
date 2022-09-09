'use strict'

const TracingPlugin = require('./tracing')

class DatabasePlugin extends TracingPlugin {
  // TODO: exit span when AsyncResource instances are removed.
}

module.exports = DatabasePlugin
