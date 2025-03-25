'use strict'

const RedisPlugin = require('../../datadog-plugin-redis/src')

class IOValkeyPlugin extends RedisPlugin {
  static get id () {
    return 'iovalkey'
  }
}

module.exports = IOValkeyPlugin
