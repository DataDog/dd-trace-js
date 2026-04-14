'use strict'

const { optionServiceSource } = require('../util')

function configWithFallback ({ tracerService, pluginConfig }) {
  return pluginConfig.service || tracerService
}

const redisNaming = {
  opName: () => 'redis.command',
  serviceName: configWithFallback,
  serviceSource: optionServiceSource,
}

const mySQLNaming = {
  opName: () => 'mysql.query',
  serviceName: withFunction,
  serviceSource: optionServiceSource,
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
      serviceName: configWithFallback,
      serviceSource: optionServiceSource,
    },
    'cassandra-driver': {
      opName: () => 'cassandra.query',
      serviceName: configWithFallback,
      serviceSource: optionServiceSource,
    },
    couchbase: {
      opName: () => 'couchbase.query',
      serviceName: configWithFallback,
      serviceSource: optionServiceSource,
    },
    elasticsearch: {
      opName: () => 'elasticsearch.query',
      serviceName: configWithFallback,
      serviceSource: optionServiceSource,
    },
    ioredis: redisNaming,
    iovalkey: {
      opName: () => 'valkey.command',
      serviceName: configWithFallback,
      serviceSource: optionServiceSource,
    },
    mariadb: {
      opName: () => 'mariadb.query',
      serviceName: withFunction,
      serviceSource: optionServiceSource,
    },
    memcached: {
      opName: () => 'memcached.command',
      serviceName: configWithFallback,
      serviceSource: optionServiceSource,
    },
    'mongodb-core': {
      opName: () => 'mongodb.query',
      serviceName: configWithFallback,
      serviceSource: optionServiceSource,
    },
    mysql: mySQLNaming,
    mysql2: mySQLNaming,
    opensearch: {
      opName: () => 'opensearch.query',
      serviceName: configWithFallback,
      serviceSource: optionServiceSource,
    },
    oracledb: {
      opName: () => 'oracle.query',
      serviceName: withFunction,
      serviceSource: optionServiceSource,
    },
    pg: {
      opName: () => 'postgresql.query',
      serviceName: withFunction,
      serviceSource: optionServiceSource,
    },
    prisma: {
      opName: ({ operation }) => `prisma.${operation}`,
      serviceName: configWithFallback,
      serviceSource: optionServiceSource,
    },
    redis: redisNaming,
    tedious: {
      opName: () => 'mssql.query',
      serviceName: configWithFallback,
      serviceSource: optionServiceSource,
    },
  },
}

module.exports = storage
