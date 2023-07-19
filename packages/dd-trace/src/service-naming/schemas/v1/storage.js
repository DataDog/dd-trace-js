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

function withFunction (service, config, params) {
  if (typeof config.service === 'function') {
    return config.service(params)
  }
  return configWithFallback(service, config)
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
    'mongodb-core': {
      opName: () => 'mongodb.query',
      serviceName: configWithFallback
    },
    mysql: mySQLNaming,
    mysql2: mySQLNaming,
    opensearch: {
      opName: () => 'opensearch.query',
      serviceName: configWithFallback
    },
    oracledb: {
      opName: () => 'oracle.query',
      serviceName: withFunction
    },
    pg: {
      opName: () => 'postgresql.query',
      serviceName: withFunction
    },
    redis: redisNaming,
    tedious: {
      opName: () => 'mssql.query',
      serviceName: configWithFallback
    }
  }
}

module.exports = storage
