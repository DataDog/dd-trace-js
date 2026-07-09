'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const MongodbCoreBulkWritePlugin = require('./bulk-write')
const MongodbCoreQueryPlugin = require('./query')

class MongodbCorePlugin extends CompositePlugin {
  static id = 'mongodb-core'
  static get plugins () {
    return {
      query: MongodbCoreQueryPlugin,
      bulkWrite: MongodbCoreBulkWritePlugin,
    }
  }
}

module.exports = MongodbCorePlugin
