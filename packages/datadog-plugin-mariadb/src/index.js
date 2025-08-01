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
}

module.exports = MariadbPlugin
