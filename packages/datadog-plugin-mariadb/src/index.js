'use strict'

const { storage } = require('../../datadog-core')
const MySQLPlugin = require('../../datadog-plugin-mysql/src')

class MariadbPlugin extends MySQLPlugin {
  static get id () { return 'mariadb' }
  static get system () { return 'mariadb' }

  constructor (...args) {
    super(...args)

    this.addSub(`apm:${this.component}:connection:start`, ctx => {
      ctx.parentStore = storage('legacy').getStore()
    })

    this.addBind(`apm:${this.component}:connection:finish`, ctx => ctx.parentStore)

    this.addBind(`apm:${this.component}:pool:skip`, () => ({ noop: true }))

    this.addSub(`apm:${this.component}:command:add`, ctx => {
      ctx.parentStore = storage('legacy').getStore()
    })
  }
}

module.exports = MariadbPlugin
