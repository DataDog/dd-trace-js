'use strict'

const { storage, SPAN_NAMESPACE } = require('../../datadog-core')
const MySQLPlugin = require('../../datadog-plugin-mysql/src')

let skippedStore

class MariadbPlugin extends MySQLPlugin {
  static get id () { return 'mariadb' }
  static get system () { return 'mariadb' }

  constructor (...args) {
    super(...args)

    this.addSub(`apm:${this.component}:pool:skip`, () => {
      skippedStore = storage(SPAN_NAMESPACE).getStore()
      storage(SPAN_NAMESPACE).enterWith({ noop: true })
    })

    this.addSub(`apm:${this.component}:pool:unskip`, () => {
      storage(SPAN_NAMESPACE).enterWith(skippedStore)
      skippedStore = undefined
    })
  }
}

module.exports = MariadbPlugin
