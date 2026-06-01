'use strict'

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

function optionServiceSource ({ pluginConfig, integration, connectionName }) {
  if (pluginConfig.splitByInstance && connectionName) {
    return 'opt.split_by_instance'
  }

  if (pluginConfig.service) {
    return 'opt.plugin'
  }

  return integration
}

const redisConfig = {
  opName: () => 'redis.command',
  serviceName: ({ tracerService, pluginConfig, system, connectionName }) => {
    return getRedisService(pluginConfig, connectionName) || fromSystem(tracerService, system)
  },
  serviceSource: ({ tracerService, pluginConfig, connectionName }) => {
    return optionServiceSource({ tracerService, pluginConfig, connectionName, integration: 'redis' })
  },
}

const valkeyConfig = {
  opName: () => 'valkey.command',
  serviceName: ({ tracerService, pluginConfig, system, connectionName }) => {
    return getRedisService(pluginConfig, connectionName) || fromSystem(tracerService, system)
  },
  serviceSource: ({ tracerService, pluginConfig, connectionName }) => {
    return optionServiceSource({ tracerService, pluginConfig, connectionName, integration: 'valkey' })
  },
}

const storage = {
  client: {
    aerospike: {
      opName: () => 'aerospike.command',
      serviceName: ({ tracerService, pluginConfig }) =>
        pluginConfig.service || `${tracerService}-aerospike`,
      serviceSource: ({ tracerService, pluginConfig, connectionName }) => {
        return optionServiceSource({ tracerService, pluginConfig, connectionName, integration: 'aerospike' })
      },
    },
    'cassandra-driver': {
      opName: () => 'cassandra.query',
      serviceName: ({ tracerService, pluginConfig, system }) =>
        pluginConfig.service || fromSystem(tracerService, system),
      serviceSource: ({ tracerService, pluginConfig, connectionName }) => {
        return optionServiceSource({ tracerService, pluginConfig, connectionName, integration: 'cassandra-driver' })
      },
    },
    couchbase: {
      opName: ({ operation }) => `couchbase.${operation}`,
      serviceName: ({ tracerService, pluginConfig }) => pluginConfig.service || `${tracerService}-couchbase`,
      serviceSource: ({ tracerService, pluginConfig, connectionName }) => {
        return optionServiceSource({ tracerService, pluginConfig, connectionName, integration: 'couchbase' })
      },
    },
    elasticsearch: {
      opName: () => 'elasticsearch.query',
      serviceName: ({ tracerService, pluginConfig }) =>
        pluginConfig.service || `${tracerService}-elasticsearch`,
      serviceSource: ({ tracerService, pluginConfig, connectionName }) => {
        return optionServiceSource({ tracerService, pluginConfig, connectionName, integration: 'elasticsearch' })
      },
    },
    ioredis: redisConfig,
    iovalkey: valkeyConfig,
    mariadb: {
      opName: () => 'mariadb.query',
      serviceName: mysqlServiceName,
      serviceSource: ({ tracerService, pluginConfig, connectionName }) => {
        return optionServiceSource({ tracerService, pluginConfig, connectionName, integration: 'mysql' })
      },
    },
    memcached: {
      opName: () => 'memcached.command',
      serviceName: ({ tracerService, pluginConfig, system }) =>
        pluginConfig.service || fromSystem(tracerService, system),
      serviceSource: ({ tracerService, pluginConfig, connectionName }) => {
        return optionServiceSource({ tracerService, pluginConfig, connectionName, integration: 'memcached' })
      },
    },
    'mongodb-core': {
      opName: () => 'mongodb.query',
      serviceName: ({ tracerService, pluginConfig }) =>
        pluginConfig.service || `${tracerService}-mongodb`,
      serviceSource: ({ tracerService, pluginConfig, connectionName }) => {
        return optionServiceSource({ tracerService, pluginConfig, connectionName, integration: 'mongodb' })
      },
    },
    mysql: {
      opName: () => 'mysql.query',
      serviceName: mysqlServiceName,
      serviceSource: ({ tracerService, pluginConfig, connectionName }) => {
        return optionServiceSource({ tracerService, pluginConfig, connectionName, integration: 'mysql' })
      },
    },
    mysql2: {
      opName: () => 'mysql.query',
      serviceName: mysqlServiceName,
      serviceSource: ({ tracerService, pluginConfig, connectionName }) => {
        return optionServiceSource({ tracerService, pluginConfig, connectionName, integration: 'mysql' })
      },
    },
    opensearch: {
      opName: () => 'opensearch.query',
      serviceName: ({ tracerService, pluginConfig }) =>
        pluginConfig.service || `${tracerService}-opensearch`,
      serviceSource: ({ tracerService, pluginConfig, connectionName }) => {
        return optionServiceSource({ tracerService, pluginConfig, connectionName, integration: 'opensearch' })
      },
    },
    oracledb: {
      opName: () => 'oracle.query',
      serviceName: withSuffixFunction('oracle'),
      serviceSource: ({ tracerService, pluginConfig, connectionName }) => {
        return optionServiceSource({ tracerService, pluginConfig, connectionName, integration: 'oracledb' })
      },
    },
    pg: {
      opName: () => 'pg.query',
      serviceName: withSuffixFunction('postgres'),
      serviceSource: ({ tracerService, pluginConfig, connectionName }) => {
        return optionServiceSource({ tracerService, pluginConfig, connectionName, integration: 'pg' })
      },
    },
    prisma: {
      opName: ({ operation }) => `prisma.${operation}`,
      serviceName: withSuffixFunction('prisma'),
      serviceSource: ({ tracerService, pluginConfig, connectionName }) => {
        return optionServiceSource({ tracerService, pluginConfig, connectionName, integration: 'prisma' })
      },
    },
    redis: redisConfig,
    tedious: {
      opName: () => 'tedious.request',
      serviceName: ({ tracerService, pluginConfig, system }) =>
        pluginConfig.service || fromSystem(tracerService, system),
      serviceSource: ({ tracerService, pluginConfig, connectionName }) => {
        return optionServiceSource({ tracerService, pluginConfig, connectionName, integration: 'tedious' })
      },
    },
  },
}

module.exports = storage
