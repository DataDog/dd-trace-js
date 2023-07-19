const { identityService } = require('../util')
const { DD_MAJOR } = require('../../../../../../version')

const web = {
  client: {
    grpc: {
      opName: () => DD_MAJOR <= 2 ? 'grpc.request' : 'grpc.client',
      serviceName: identityService
    },
    moleculer: {
      opName: () => 'moleculer.call',
      serviceName: identityService
    }
  },
  server: {
    grpc: {
      opName: () => DD_MAJOR <= 2 ? 'grpc.request' : 'grpc.server',
      serviceName: identityService
    },
    moleculer: {
      opName: () => 'moleculer.action',
      serviceName: identityService
    }
  }
}

module.exports = web
