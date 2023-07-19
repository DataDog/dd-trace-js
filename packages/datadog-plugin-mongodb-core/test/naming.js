const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

module.exports = resolveNaming({
  outbound: {
    v0: {
      opName: 'mongodb.query',
      serviceName: 'test-mongodb'
    },
    v1: {
      opName: 'mongodb.query',
      serviceName: 'test'
    }
  }
})
