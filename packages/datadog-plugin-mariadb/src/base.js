'use strict'

const { storage } = require('../../datadog-core')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class MariaDBPipelineBase extends DatabasePlugin {
  static system = 'mariadb'

  /**
   * Preserve MariaDB-specific context boundaries that are independent of span policy.
   *
   * @param {...unknown} args Database plugin constructor arguments.
   */
  constructor (...args) {
    super(...args)

    this.addBind('apm:mariadb:query:finish', ctx => ctx.sourceParentStore, { allowNoop: true })
    this.addBind('apm:mariadb:pool:skip', () => ({ noop: true }))

    this.addSub('apm:mariadb:command:add', ctx => {
      ctx.sourceParentStore = storage('legacy').getStore()
    })

    this.addSub('apm:mariadb:connection:start', ctx => {
      ctx.currentStore = storage('legacy').getStore()
    })
    this.addBind('apm:mariadb:connection:finish', ctx => ctx.currentStore)
  }
}

module.exports = MariaDBPipelineBase
