'use strict'

const RedisPlugin = require('../../datadog-plugin-redis/src')

class IOValkeyPlugin extends RedisPlugin {
  static get id () {
    return 'iovalkey'
  }

  static get system () { return 'valkey' }

  constructor (...args) {
    super(...args)
    this._spanType = 'valkey'
  }
}

module.exports = IOValkeyPlugin
