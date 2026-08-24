'use strict'

const { storage } = require('../../datadog-core')
const { createDatabaseIntegration } = require('../../dd-trace/src/events/database')
const MySQLPlugin = require('../../datadog-plugin-mysql/src')
const querySource = require('./query-source')

const DatabaseQueryIntegration = createDatabaseIntegration({
  base: MySQLPlugin,
  id: 'mariadb',
  system: 'mariadb',
  operations: [{
    operation: 'db.query',
    adapter: 'query',
    source: querySource,
  }],
})

class MariadbPlugin extends DatabaseQueryIntegration {
  static id = 'mariadb'
  static system = 'mariadb'

  constructor (...args) {
    super(...args)

    this.addBind(`apm:${this.component}:pool:skip`, () => ({ noop: true }))

    this.addSub(`apm:${this.component}:command:add`, ctx => {
      ctx.parentStore = storage('legacy').getStore()
    })
  }
}

module.exports = MariadbPlugin
