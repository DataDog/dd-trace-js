'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const { storage } = require('../../datadog-core')

class MongoosePlugin extends DatabasePlugin {
  static get id () { return 'mongoose' }
  static get operation () { return 'exec' }

  bindStart (ctx) {
    ctx.parentStore = storage('legacy').getStore()
    return ctx.parentStore
  }

  bindFinish (ctx) {
    return ctx.parentStore
  }
}

module.exports = MongoosePlugin
