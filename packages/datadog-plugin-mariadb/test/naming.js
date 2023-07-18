const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

module.exports = resolveNaming({
  outbound: {
    v0: {
      opName: 'mariadb.query',
      serviceName: 'test-mariadb'
    },
    v1: {
      opName: 'mariadb.query',
      serviceName: 'test'
    }
  }
})
