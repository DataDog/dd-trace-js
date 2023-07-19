const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

module.exports = resolveNaming({
  client: {
    v0: {
      opName: 'moleculer.call',
      serviceName: 'test'
    },
    v1: {
      opName: 'moleculer.client.request',
      serviceName: 'test'
    }
  },
  server: {
    v0: {
      opName: 'moleculer.action',
      serviceName: 'test'
    },
    v1: {
      opName: 'moleculer.server.request',
      serviceName: 'test'
    }
  }
})
