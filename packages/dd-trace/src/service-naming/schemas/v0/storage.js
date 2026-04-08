'use strict'

function getRedisService (opts, pluginConfig, connectionName) {
  if (pluginConfig.splitByInstance && connectionName) {
    if (pluginConfig.service) {
      opts.srvSrc = pluginConfig.serviceFromMapping ? 'opt.mapping' : 'm'
      return `${pluginConfig.service}-${connectionName}`
    }
    opts.srvSrc = 'redis'
    return connectionName
  }

  if (pluginConfig.service) {
    opts.srvSrc = pluginConfig.serviceFromMapping ? 'opt.mapping' : 'm'
    return pluginConfig.service
  }
}

function fromSystem (opts, tracerService, system, integrationName) {
  if (system) {
    opts.srvSrc = integrationName
    return `${tracerService}-${system}`
  }
}

function mysqlServiceName (opts) {
  const { tracerService, pluginConfig, dbConfig, system } = opts
  if (typeof pluginConfig.service === 'function') {
    opts.srvSrc = 'm'
    return pluginConfig.service(dbConfig)
  }
  if (pluginConfig.service) {
    opts.srvSrc = pluginConfig.serviceFromMapping ? 'opt.mapping' : 'm'
    return pluginConfig.service
  }
  return fromSystem(opts, tracerService, system, 'mysql')
}

function withSuffixFunction (suffix, integrationName) {
  return (opts) => {
    const { tracerService, pluginConfig, params } = opts
    if (typeof pluginConfig.service === 'function') {
      opts.srvSrc = 'm'
      return pluginConfig.service(params)
    }
    if (pluginConfig.service) {
      opts.srvSrc = pluginConfig.serviceFromMapping ? 'opt.mapping' : 'm'
      return pluginConfig.service
    }
    opts.srvSrc = integrationName
    return `${tracerService}-${suffix}`
  }
}

const redisConfig = {
  opName: () => 'redis.command',
  serviceName: (opts) => {
    const { tracerService, pluginConfig, system, connectionName } = opts
    return getRedisService(opts, pluginConfig, connectionName) || fromSystem(opts, tracerService, system, 'redis')
  },
}

const valkeyConfig = {
  opName: () => 'valkey.command',
  serviceName: (opts) => {
    const { tracerService, pluginConfig, system, connectionName } = opts
    return getRedisService(opts, pluginConfig, connectionName) || fromSystem(opts, tracerService, system, 'valkey')
  },
}

const storage = {
  client: {
    aerospike: {
      opName: () => 'aerospike.command',
      serviceName: (opts) => {
        const { tracerService, pluginConfig } = opts
        if (pluginConfig.service) {
          opts.srvSrc = pluginConfig.serviceFromMapping ? 'opt.mapping' : 'm'
          return pluginConfig.service
        }
        opts.srvSrc = 'aerospike'
        return `${tracerService}-aerospike`
      },
    },
    'cassandra-driver': {
      opName: () => 'cassandra.query',
      serviceName: (opts) => {
        const { tracerService, pluginConfig, system } = opts
        if (pluginConfig.service) {
          opts.srvSrc = pluginConfig.serviceFromMapping ? 'opt.mapping' : 'm'
          return pluginConfig.service
        }
        return fromSystem(opts, tracerService, system, 'cassandra-driver')
      },
    },
    couchbase: {
      opName: ({ operation }) => `couchbase.${operation}`,
      serviceName: (opts) => {
        const { tracerService, pluginConfig } = opts
        if (pluginConfig.service) {
          opts.srvSrc = pluginConfig.serviceFromMapping ? 'opt.mapping' : 'm'
          return pluginConfig.service
        }
        opts.srvSrc = 'couchbase'
        return `${tracerService}-couchbase`
      },
    },
    elasticsearch: {
      opName: () => 'elasticsearch.query',
      serviceName: (opts) => {
        const { tracerService, pluginConfig } = opts
        if (pluginConfig.service) {
          opts.srvSrc = pluginConfig.serviceFromMapping ? 'opt.mapping' : 'm'
          return pluginConfig.service
        }
        opts.srvSrc = 'elasticsearch'
        return `${tracerService}-elasticsearch`
      },
    },
    ioredis: redisConfig,
    iovalkey: valkeyConfig,
    mariadb: {
      opName: () => 'mariadb.query',
      serviceName: mysqlServiceName,
    },
    memcached: {
      opName: () => 'memcached.command',
      serviceName: (opts) => {
        const { tracerService, pluginConfig, system } = opts
        if (pluginConfig.service) {
          opts.srvSrc = pluginConfig.serviceFromMapping ? 'opt.mapping' : 'm'
          return pluginConfig.service
        }
        return fromSystem(opts, tracerService, system, 'memcached')
      },
    },
    'mongodb-core': {
      opName: () => 'mongodb.query',
      serviceName: (opts) => {
        const { tracerService, pluginConfig } = opts
        if (pluginConfig.service) {
          opts.srvSrc = pluginConfig.serviceFromMapping ? 'opt.mapping' : 'm'
          return pluginConfig.service
        }
        opts.srvSrc = 'mongodb-core'
        return `${tracerService}-mongodb`
      },
    },
    mysql: {
      opName: () => 'mysql.query',
      serviceName: mysqlServiceName,
    },
    mysql2: {
      opName: () => 'mysql.query',
      serviceName: mysqlServiceName,
    },
    opensearch: {
      opName: () => 'opensearch.query',
      serviceName: (opts) => {
        const { tracerService, pluginConfig } = opts
        if (pluginConfig.service) {
          opts.srvSrc = pluginConfig.serviceFromMapping ? 'opt.mapping' : 'm'
          return pluginConfig.service
        }
        opts.srvSrc = 'opensearch'
        return `${tracerService}-opensearch`
      },
    },
    oracledb: {
      opName: () => 'oracle.query',
      serviceName: withSuffixFunction('oracle', 'oracledb'),
    },
    pg: {
      opName: () => 'pg.query',
      serviceName: withSuffixFunction('postgres', 'pg'),
    },
    prisma: {
      opName: ({ operation }) => `prisma.${operation}`,
      serviceName: withSuffixFunction('prisma', 'prisma'),
    },
    redis: redisConfig,
    tedious: {
      opName: () => 'tedious.request',
      serviceName: (opts) => {
        const { tracerService, pluginConfig, system } = opts
        if (pluginConfig.service) {
          opts.srvSrc = pluginConfig.serviceFromMapping ? 'opt.mapping' : 'm'
          return pluginConfig.service
        }
        return fromSystem(opts, tracerService, system, 'tedious')
      },
    },
  },
}

module.exports = storage
