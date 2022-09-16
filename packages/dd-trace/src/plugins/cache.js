'use strict'

const StoragePlugin = require('./storage')

class CachePlugin extends StoragePlugin {
  static operation = 'command'
}

module.exports = CachePlugin
