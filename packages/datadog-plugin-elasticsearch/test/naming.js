const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

module.exports = resolveNaming({
  outbound: {
    v0: {
      opName: 'elasticsearch.query',
      serviceName: 'test-elasticsearch'
    },
    v1: {
      opName: 'elasticsearch.query',
      serviceName: 'test'
    }
  }
})
