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
    'cassandra-driver': {
      opName: () => 'cassandra.query',
      serviceName: configWithFallback
    },
    elasticsearch: {
      opName: () => 'elasticsearch.query',
      serviceName: configWithFallback
    },
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
    opensearch: {
      opName: () => 'opensearch.query',
      serviceName: configWithFallback
    },
    redis: redisNaming,
    tedious: {
      opName: () => 'mssql.query',
      serviceName: configWithFallback
    }
  }
}

module.exports = storage
