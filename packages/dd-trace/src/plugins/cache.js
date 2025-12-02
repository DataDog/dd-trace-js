'use strict'

const StoragePlugin = require('./storage')

class CachePlugin extends StoragePlugin {
  static operation = 'command'

  startSpan (name, options, ctx) {
    if (typeof name === 'object' && name !== null && ctx === undefined) {
      ctx = options
      options = name
      name = this.operationName()
    }

    if (!options.kind) {
      options.kind = this.constructor.kind
    }
    return super.startSpan(name, options, ctx)
  }
}

module.exports = CachePlugin
