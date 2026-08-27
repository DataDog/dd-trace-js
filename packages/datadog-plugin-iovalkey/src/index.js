'use strict'

const RedisPlugin = require('../../datadog-plugin-redis/src')
const {
  configuredInstanceService,
  configuredService,
  optionServiceSource,
  storageServiceSource,
} = require('../../dd-trace/src/service-naming/helpers')

/** @type {import('../../dd-trace/src/plugins/tracing').NamingSchema} */
const namingSchema = {
  v0: {
    operationName: () => 'valkey.command',
    serviceName: configuredInstanceService,
    serviceSource: storageServiceSource('valkey'),
  },
  v1: {
    operationName: () => 'valkey.command',
    serviceName: configuredService,
    serviceSource: optionServiceSource,
  },
}

class IOValkeyPlugin extends RedisPlugin {
  static id = 'iovalkey'

  static system = 'valkey'

  /** @override */
  getNamingSchema () {
    return namingSchema
  }

  constructor (...args) {
    super(...args)
    this._spanType = 'valkey'
  }
}

module.exports = IOValkeyPlugin
