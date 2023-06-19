function getRedisService (config, connectionName) {
  if (config.splitByInstance && connectionName) {
    return config.service
      ? `${config.service}-${connectionName}`
      : connectionName
  }

  return config.service
}

function fromSystem (service, system) {
  return system ? `${service}-${system}` : undefined
}

function mysqlServiceName (service, config, dbConfig, system) {
  if (typeof config.service === 'function') {
    return config.service(dbConfig)
  }
  return config.service || fromSystem(service, system)
}

function withSuffixFunction (suffix) {
  return (service, config, params) => {
    if (typeof config.service === 'function') {
      return config.service(params)
    }
    return config.service || `${service}-${suffix}`
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
      serviceName: (service, config, system) => config.service || fromSystem(service, system)
    }
  }
}

module.exports = storage
