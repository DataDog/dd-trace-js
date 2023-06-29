const { identityService, httpPluginClientService } = require('../util')

const web = {
  client: {
    moleculer: {
      opName: () => 'moleculer.client.request',
      serviceName: identityService
    },
    http: {
      opName: () => 'http.client.request',
      serviceName: httpPluginClientService
    },
    http2: {
      opName: () => 'http.client.request',
      serviceName: httpPluginClientService
    }
  },
  server: {
    moleculer: {
      opName: () => 'moleculer.server.request',
      serviceName: identityService
    },
    http: {
      opName: () => 'http.server.request',
      serviceName: identityService
    },
    http2: {
      opName: () => 'http.server.request',
      serviceName: identityService
    },
    next: {
      opName: () => 'http.server.request',
      serviceName: identityService
    }
  }
}

module.exports = web
