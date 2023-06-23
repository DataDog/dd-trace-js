const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

module.exports = resolveNaming({
  outbound: {
    v0: {
      opName: 'pg.query',
      serviceName: 'test-postgres'
    },
    v1: {
      opName: 'postgresql.query',
      serviceName: 'test'
    }
  }
})
