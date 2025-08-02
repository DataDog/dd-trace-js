'use strict'

const RedisPlugin = require('../../datadog-plugin-redis/src')

class IOValkeyPlugin extends RedisPlugin {
  static id = 'iovalkey'

  static system = 'valkey'

  constructor (...args) {
    super(...args)
    this._spanType = 'valkey'
  }
}

module.exports = IOValkeyPlugin
