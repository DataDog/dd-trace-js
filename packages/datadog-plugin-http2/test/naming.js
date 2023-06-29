const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

module.exports = resolveNaming({
  client: {
    v0: {
      opName: 'http.request',
      serviceName: 'test'
    },
    v1: {
      opName: 'http.client.request',
      serviceName: 'test'
    }
  },
  server: {
    v0: {
      opName: 'web.request',
      serviceName: 'test'
    },
    v1: {
      opName: 'http.server.request',
      serviceName: 'test'
    }
  }
})
