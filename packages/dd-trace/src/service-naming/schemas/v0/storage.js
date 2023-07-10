function getRedisService ({ pluginConfig, connectionName }) {
  if (pluginConfig.splitByInstance && connectionName) {
    return pluginConfig.service
      ? `${pluginConfig.service}-${connectionName}`
      : connectionName
  }

  return pluginConfig.service
}

function fromSystem ({ tracerService, system }) {
  return system ? `${tracerService}-${system}` : undefined
}

function mysqlServiceName ({ tracerService, pluginConfig, dbConfig, system }) {
  if (typeof pluginConfig.service === 'function') {
    return pluginConfig.service(dbConfig)
  }
  return pluginConfig.service || fromSystem({ tracerService, system })
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
  serviceName: (service, config, system, connectionName) => {
    return getRedisService(config, connectionName) || fromSystem(service, system)
  }
}

const storage = {
  client: {
    'cassandra-driver': {
      opName: () => 'cassandra.query',
      serviceName: (service, config, system) => config.service || fromSystem(service, system)
    },
    elasticsearch: {
      opName: () => 'elasticsearch.query',
      serviceName: (service, config) => config.service || `${service}-elasticsearch`
    },
    ioredis: redisConfig,
    mariadb: {
      opName: () => 'mariadb.query',
      serviceName: mysqlServiceName
    },
    memcached: {
      opName: () => 'memcached.command',
      serviceName: (service, config, system) => config.service || fromSystem(service, system)
    },
    'mongodb-core': {
      opName: () => 'mongodb.query',
      serviceName: (service, config) => config.service || `${service}-mongodb`
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
      serviceName: (service, config) => config.service || `${service}-opensearch`
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
        pluginConfig.service || fromSystem({ tracerService, system })
    }
  }
}

module.exports = storage
