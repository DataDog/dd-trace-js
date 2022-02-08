'use strict'

const RedisPlugin = require('../../datadog-plugin-redis/src')

class IORedisPlugin extends RedisPlugin {
  static get name () {
    return 'ioredis'
  }
}

module.exports = IORedisPlugin
