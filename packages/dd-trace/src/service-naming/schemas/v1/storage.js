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
    return pluginConfig.service(params)
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
    redis: redisNaming,
    tedious: {
      opName: () => 'mssql.query',
      serviceName: configWithFallback
    }
  }
}

module.exports = storage
