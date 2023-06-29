const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

module.exports = resolveNaming({
  server: {
    v0: {
      opName: 'next.request',
      serviceName: 'test'
    },
    v1: {
      opName: 'http.server.request',
      serviceName: 'test'
    }
  }
})
