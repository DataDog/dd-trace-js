'use strict'

const StoragePlugin = require('./storage')

class CachePlugin extends StoragePlugin {
  static operation = 'command'

  startSpan (options, ctx) {
    if (!options.kind) {
      options.kind = this.constructor.kind
    }
    return super.startSpan(this.operationName(), options, ctx)
  }
}

module.exports = CachePlugin
