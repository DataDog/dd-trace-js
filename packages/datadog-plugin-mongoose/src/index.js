'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const { storage } = require('../../datadog-core')

class MongoosePlugin extends DatabasePlugin {
  static id = 'mongoose'
  static operation = 'exec'

  bindStart (ctx) {
    ctx.parentStore = storage('legacy').getStore()
    return ctx.parentStore
  }

  bindFinish (ctx) {
    return ctx.parentStore
  }
}

module.exports = MongoosePlugin
