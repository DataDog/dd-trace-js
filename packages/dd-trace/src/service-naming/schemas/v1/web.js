const { identityService } = require('../util')

const web = {
  client: {
    grpc: {
      opName: () => 'grpc.client.request',
      serviceName: identityService
    },
    moleculer: {
      opName: () => 'moleculer.client.request',
      serviceName: identityService
    }
  },
  server: {
    grpc: {
      opName: () => 'grpc.server.request',
      serviceName: identityService
    },
    moleculer: {
      opName: () => 'moleculer.server.request',
      serviceName: identityService
    }
  }
}

module.exports = web
