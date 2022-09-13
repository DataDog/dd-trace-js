'use strict'

const StoragePlugin = require('./storage')

class DatabasePlugin extends StoragePlugin {
  static operation = 'query'
}

module.exports = DatabasePlugin
