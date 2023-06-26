const { identityService } = require('../util')

const web = {
  client: {
    moleculer: {
      opName: () => 'moleculer.client.request',
      serviceName: identityService
    }
  },
  server: {
    moleculer: {
      opName: () => 'moleculer.server.request',
      serviceName: identityService
    }
  }
}

module.exports = web
