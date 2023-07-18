const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

module.exports = resolveNaming({
  outbound: {
    v0: {
      opName: 'mysql.query',
      serviceName: 'test-mysql'
    },
    v1: {
      opName: 'mysql.query',
      serviceName: 'test'
    }
  }
})
