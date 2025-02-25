'use strict'

const { storage } = require('../../datadog-core')
const MySQLPlugin = require('../../datadog-plugin-mysql/src')

let skippedStore

class MariadbPlugin extends MySQLPlugin {
  static get id () { return 'mariadb' }
  static get system () { return 'mariadb' }

  constructor (...args) {
    super(...args)

    this.addSub(`apm:${this.component}:pool:skip`, () => {
      skippedStore = storage('legacy').getStore()
      storage('legacy').enterWith({ noop: true })
    })

    this.addSub(`apm:${this.component}:pool:unskip`, () => {
      storage('legacy').enterWith(skippedStore)
      skippedStore = undefined
    })
  }
}

module.exports = MariadbPlugin
