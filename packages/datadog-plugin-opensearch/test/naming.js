const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

module.exports = resolveNaming({
  outbound: {
    v0: {
      opName: 'opensearch.query',
      serviceName: 'test-opensearch'
    },
    v1: {
      opName: 'opensearch.query',
      serviceName: 'test'
    }
  }
})
