const { identityService } = require('../util')

const web = {
  client: {
    moleculer: {
      opName: () => 'moleculer.call',
      serviceName: identityService
    }
  },
  server: {
    moleculer: {
      opName: () => 'moleculer.action',
      serviceName: identityService
    }
  }
}

module.exports = web
