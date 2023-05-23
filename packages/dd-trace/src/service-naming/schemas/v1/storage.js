function configWithFallback (service, config) {
  return config.service || service
}

const redisNaming = {
  opName: () => 'redis.command',
  serviceName: configWithFallback
}

const storage = {
  client: {
    ioredis: redisNaming,
    memcached: {
      opName: () => 'memcached.command',
      serviceName: configWithFallback
    },
    redis: redisNaming
  }
}

module.exports = storage
