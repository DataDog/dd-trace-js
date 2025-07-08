'use strict'

function configWithFallback ({ tracerService, pluginConfig }) {
  return pluginConfig.service || tracerService
}

const redisNaming = {
  opName: () => 'redis.command',
  serviceName: configWithFallback
}

const mySQLNaming = {
  opName: () => 'mysql.query',
  serviceName: withFunction
}

function withFunction ({ tracerService, pluginConfig, params }) {
  if (typeof pluginConfig.service === 'function') {
    const result = pluginConfig.service(params)
    return typeof result === 'string' && result.length > 0 ? result : tracerService
  }
  return configWithFallback({ tracerService, pluginConfig })
}

const storage = {
  client: {
    aerospike: {
      opName: () => 'aerospike.command',
      serviceName: configWithFallback
    },
    'cassandra-driver': {
      opName: () => 'cassandra.query',
      serviceName: configWithFallback
    },
    couchbase: {
      opName: () => 'couchbase.query',
      serviceName: configWithFallback
    },
    elasticsearch: {
      opName: () => 'elasticsearch.query',
      serviceName: configWithFallback
    },
    ioredis: redisNaming,
    iovalkey: {
      opName: () => 'valkey.command',
      serviceName: configWithFallback
    },
    mariadb: {
      opName: () => 'mariadb.query',
      serviceName: withFunction
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
    prisma: {
      opName: ({ operation }) => `prisma.${operation}`,
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
