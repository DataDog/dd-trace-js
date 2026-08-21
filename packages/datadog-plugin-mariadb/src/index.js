'use strict'

const { storage } = require('../../datadog-core')
const MySQLPlugin = require('../../datadog-plugin-mysql/src')

class MariadbPlugin extends MySQLPlugin {
  static id = 'mariadb'
  static system = 'mariadb'

  constructor (...args) {
    super(...args)

    this.addBind(`apm:${this.component}:pool:skip`, () => ({ noop: true }))

    this.addSub(`apm:${this.component}:command:add`, ctx => {
      ctx.parentStore = storage('legacy').getStore()
    })
  }

  /**
   * Adds pool wait time discovered after a bundled query starts, then finishes its span.
   *
   * @param {{ currentStore?: { span?: import('../../../..').Span }, poolWaitTime?: number }} ctx
   * @returns {void}
   */
  finish (ctx) {
    if (ctx.poolWaitTime !== undefined) {
      ctx.currentStore?.span?.setTag(`${this.component}.pool.wait_time`, ctx.poolWaitTime)
    }
    super.finish(ctx)
  }
}

module.exports = MariadbPlugin
