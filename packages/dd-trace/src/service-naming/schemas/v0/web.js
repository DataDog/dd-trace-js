const { identityService } = require('../util')

const web = {
  client: {
    grpc: {
      opName: () => 'grpc.client',
      serviceName: identityService
    },
    moleculer: {
      opName: () => 'moleculer.call',
      serviceName: identityService
    }
  },
  server: {
    grpc: {
      opName: () => 'grpc.server',
      serviceName: identityService
    },
    moleculer: {
      opName: () => 'moleculer.action',
      serviceName: identityService
    }
  }
}

module.exports = web
