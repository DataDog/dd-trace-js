'use strict'

const StoragePlugin = require('./storage')

class CachePlugin extends StoragePlugin {
  static get operation () { return 'command' }
}

module.exports = CachePlugin
