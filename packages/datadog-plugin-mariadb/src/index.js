'use strict'

const { storage, LEGACY_STORAGE_NAMESPACE } = require('../../datadog-core')
const MySQLPlugin = require('../../datadog-plugin-mysql/src')

let skippedStore

class MariadbPlugin extends MySQLPlugin {
  static get id () { return 'mariadb' }
  static get system () { return 'mariadb' }

  constructor (...args) {
    super(...args)

    this.addSub(`apm:${this.component}:pool:skip`, () => {
      skippedStore = storage(LEGACY_STORAGE_NAMESPACE).getStore()
      storage(LEGACY_STORAGE_NAMESPACE).enterWith({ noop: true })
    })

    this.addSub(`apm:${this.component}:pool:unskip`, () => {
      storage(LEGACY_STORAGE_NAMESPACE).enterWith(skippedStore)
      skippedStore = undefined
    })
  }
}

module.exports = MariadbPlugin
