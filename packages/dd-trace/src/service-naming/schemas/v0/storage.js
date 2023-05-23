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

const redisConfig = {
  opName: () => 'redis.command',
  serviceName: (service, config, system, connectionName) => {
    return getRedisService(config, connectionName) || fromSystem(service, system)
  }
}

const storage = {
  client: {
    ioredis: redisConfig,
    memcached: {
      opName: () => 'memcached.command',
      serviceName: (service, config, system) => config.service || fromSystem(service, system)
    },
    redis: redisConfig
  }
}

module.exports = storage
