const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

module.exports = resolveNaming({
  outbound: {
    v0: {
      opName: 'redis.command',
      serviceName: 'test-redis'
    },
    v1: {
      opName: 'redis.command',
      serviceName: 'test'
    }
  }
})
