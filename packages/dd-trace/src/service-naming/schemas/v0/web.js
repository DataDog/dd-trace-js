const { identityService, httpPluginClientService } = require('../util')

const web = {
  client: {
    moleculer: {
      opName: () => 'moleculer.call',
      serviceName: identityService
    },
    http: {
      opName: () => 'http.request',
      serviceName: httpPluginClientService
    },
    http2: {
      opName: () => 'http.request',
      serviceName: httpPluginClientService
    }
  },
  server: {
    moleculer: {
      opName: () => 'moleculer.action',
      serviceName: identityService
    },
    http: {
      opName: () => 'web.request',
      serviceName: identityService
    },
    http2: {
      opName: () => 'web.request',
      serviceName: identityService
    }
  }
}

module.exports = web
