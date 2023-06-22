const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

module.exports = resolveNaming({
  server: {
    v0: {
      opName: 'graphql.execute',
      serviceName: 'test'
    },
    v1: {
      opName: 'graphql.server.request',
      serviceName: 'test'
    }
  }
})
