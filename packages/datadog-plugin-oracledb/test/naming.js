const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

module.exports = resolveNaming({
  outbound: {
    v0: {
      opName: 'oracle.query',
      serviceName: 'test-oracle'
    },
    v1: {
      opName: 'oracle.query',
      serviceName: 'test'
    }
  }
})
