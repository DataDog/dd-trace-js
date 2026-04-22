'use strict'

const EventPlugin = require('./event')

class ZlibPlugin extends EventPlugin {
  static id = 'zlib'

  static operation = 'operation'

  static entryType = 'zlib'

  extendEvent (event, ctx) {
    event.detail = { operation: ctx.operation }

    return event
  }
}

module.exports = ZlibPlugin
