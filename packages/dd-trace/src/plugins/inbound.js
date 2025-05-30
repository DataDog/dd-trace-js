'use strict'

const TracingPlugin = require('./tracing')

class InboundPlugin extends TracingPlugin {
  bindFinish (ctx) {
    return ctx.parentStore
  }
}

module.exports = InboundPlugin
