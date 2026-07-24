'use strict'

const { storage } = require('../../datadog-core')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const { startQuerySpan } = require('./shared')

class MySQLPlugin extends DatabasePlugin {
  static id = 'mysql'
  static system = 'mysql'

  constructor () {
    super(...arguments)

    // Capture into `currentStore` (not `parentStore`) so connection:finish can
    // restore the caller context even when the connection resolves inside an
    // instrumentation skip (a noop store), as the mariadb pool does: the store
    // binding only honors an explicit `currentStore` through a noop store.
    // Without a skip (mysql/mysql2) this is unchanged.
    this.addSub(`apm:${this.component}:connection:start`, ctx => {
      ctx.currentStore = storage('legacy').getStore()
    })

    this.addBind(`apm:${this.component}:connection:finish`, ctx => ctx.currentStore)
  }

  bindStart (ctx) {
    return startQuerySpan(this, ctx)
  }
}

module.exports = MySQLPlugin
