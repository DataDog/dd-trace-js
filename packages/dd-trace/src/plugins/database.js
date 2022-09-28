'use strict'

const StoragePlugin = require('./storage')

class DatabasePlugin extends StoragePlugin {
  static get operation () { return 'query' }
}

module.exports = DatabasePlugin
