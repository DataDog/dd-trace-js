'use strict'

const { storage } = require('../../datadog-core')
const MySQLPlugin = require('../../datadog-plugin-mysql/src')
const {
  configuredDatabaseService,
  configuredServiceWithFunction,
  optionServiceSource,
  storageServiceSource,
} = require('../../dd-trace/src/service-naming/helpers')

/** @type {import('../../dd-trace/src/plugins/tracing').NamingSchema} */
const namingSchema = {
  v0: {
    operationName: () => 'mariadb.query',
    serviceName: configuredDatabaseService,
    serviceSource: storageServiceSource('mysql'),
  },
  v1: {
    operationName: () => 'mariadb.query',
    serviceName: configuredServiceWithFunction,
    serviceSource: optionServiceSource,
  },
}

class MariadbPlugin extends MySQLPlugin {
  static id = 'mariadb'
  static system = 'mariadb'

  /** @override */
  getNamingSchema () {
    return namingSchema
  }

  constructor (...args) {
    super(...args)

    this.addBind(`apm:${this.component}:pool:skip`, () => ({ noop: true }))

    this.addSub(`apm:${this.component}:command:add`, ctx => {
      ctx.parentStore = storage('legacy').getStore()
    })
  }
}

module.exports = MariadbPlugin
