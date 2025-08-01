'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const { storage } = require('../../datadog-core')

class KnexPlugin extends DatabasePlugin {
  static id = 'knex'
  static operation = 'query'

  bindStart (ctx) {
    ctx.parentStore = storage('legacy').getStore()
    return ctx.parentStore
  }

  bindFinish (ctx) {
    return ctx.parentStore
  }
}

module.exports = KnexPlugin
