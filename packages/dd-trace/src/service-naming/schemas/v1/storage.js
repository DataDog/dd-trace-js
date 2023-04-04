const { identityService } = require('../util')

function configWithFallback (service, config) {
  return config.service || service
}

const redisNaming = {
  opName: () => 'redis.command',
  serviceName: configWithFallback
}

const mySQLNaming = {
  opName: () => 'mysql.query',
  serviceName: identityService
}

const storage = {
  client: {
    ioredis: redisNaming,
    mariadb: {
      opName: () => 'mariadb.query',
      serviceName: identityService
    },
    memcached: {
      opName: () => 'memcached.command',
      serviceName: configWithFallback
    },
    mysql: mySQLNaming,
    mysql2: mySQLNaming,
    redis: redisNaming
  }
}

module.exports = storage
