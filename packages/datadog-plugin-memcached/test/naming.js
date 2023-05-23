const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

module.exports = resolveNaming({
  outbound: {
    v0: {
      opName: 'memcached.command',
      serviceName: 'test-memcached'
    },
    v1: {
      opName: 'memcached.command',
      serviceName: 'test'
    }
  }
})
