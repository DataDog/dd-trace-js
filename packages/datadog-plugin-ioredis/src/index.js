'use strict'

const RedisPlugin = require('../../datadog-plugin-redis/src')

class IORedisPlugin extends RedisPlugin {
  static id = 'ioredis'
}

module.exports = IORedisPlugin
