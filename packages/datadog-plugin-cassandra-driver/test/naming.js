const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

module.exports = resolveNaming({
  outbound: {
    v0: {
      opName: 'cassandra.query',
      serviceName: 'test-cassandra'
    },
    v1: {
      opName: 'cassandra.query',
      serviceName: 'test'
    }
  }
})
