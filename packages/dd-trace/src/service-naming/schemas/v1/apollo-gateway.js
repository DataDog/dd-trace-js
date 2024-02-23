
const { identityService } = require('../util')

const apolloGateway = {
  server: {
    'apollo-gateway': {
      opName: () => 'apollo-gateway.request',
      serviceName: identityService
    }
  }
}

module.exports = apolloGateway
