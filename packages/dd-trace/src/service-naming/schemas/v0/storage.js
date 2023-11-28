function getRedisService (pluginConfig, connectionName) {
  if (pluginConfig.splitByInstance && connectionName) {
    return pluginConfig.service
      ? `${pluginConfig.service}-${connectionName}`
      : connectionName
  }

  return pluginConfig.service
}

function fromSystem (tracerService, system) {
  return system ? `${tracerService}-${system}` : undefined
}

function mysqlServiceName ({ tracerService, pluginConfig, dbConfig, system }) {
  if (typeof pluginConfig.service === 'function') {
    return pluginConfig.service(dbConfig)
  }
  return pluginConfig.service || fromSystem(tracerService, system)
}

function withSuffixFunction (suffix) {
  return ({ tracerService, pluginConfig, params }) => {
    if (typeof pluginConfig.service === 'function') {
      return pluginConfig.service(params)
    }
    return pluginConfig.service || `${tracerService}-${suffix}`
  }
}

const redisConfig = {
  opName: () => 'redis.command',
  serviceName: ({ tracerService, pluginConfig, system, connectionName }) => {
    return getRedisService(pluginConfig, connectionName) || fromSystem(tracerService, system)
  }
}

const storage = {
  client: {
    aerospike: {
      opName: () => 'aerospike.command',
      serviceName: ({ tracerService, pluginConfig }) =>
        pluginConfig.service || `${tracerService}-aerospike`
    },
    'cassandra-driver': {
      opName: () => 'cassandra.query',
      serviceName: ({ tracerService, pluginConfig, system }) =>
        pluginConfig.service || fromSystem(tracerService, system)
    },
    couchbase: {
      opName: ({ operation }) => `couchbase.${operation}`,
      serviceName: ({ tracerService, pluginConfig }) => pluginConfig.service || `${tracerService}-couchbase`
    },
    elasticsearch: {
      opName: () => 'elasticsearch.query',
      serviceName: ({ tracerService, pluginConfig }) =>
        pluginConfig.service || `${tracerService}-elasticsearch`
    },
    ioredis: redisConfig,
    mariadb: {
      opName: () => 'mariadb.query',
      serviceName: mysqlServiceName
    },
    memcached: {
      opName: () => 'memcached.command',
      serviceName: ({ tracerService, pluginConfig, system }) =>
        pluginConfig.service || fromSystem(tracerService, system)
    },
    'mongodb-core': {
      opName: () => 'mongodb.query',
      serviceName: ({ tracerService, pluginConfig }) =>
        pluginConfig.service || `${tracerService}-mongodb`
    },
    mysql: {
      opName: () => 'mysql.query',
      serviceName: mysqlServiceName
    },
    mysql2: {
      opName: () => 'mysql.query',
      serviceName: mysqlServiceName
    },
    opensearch: {
      opName: () => 'opensearch.query',
      serviceName: ({ tracerService, pluginConfig }) =>
        pluginConfig.service || `${tracerService}-opensearch`
    },
    oracledb: {
      opName: () => 'oracle.query',
      serviceName: withSuffixFunction('oracle')
    },
    pg: {
      opName: () => 'pg.query',
      serviceName: withSuffixFunction('postgres')
    },
    redis: redisConfig,
    tedious: {
      opName: () => 'tedious.request',
      serviceName: ({ tracerService, pluginConfig, system }) =>
        pluginConfig.service || fromSystem(tracerService, system)
    }
  }
}

module.exports = storage
