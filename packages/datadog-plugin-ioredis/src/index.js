'use strict'

const RedisPlugin = require('../../datadog-plugin-redis/src')

class IORedisPlugin extends RedisPlugin {
  static get id () {
    return 'ioredis'
  }
}

module.exports = IORedisPlugin
