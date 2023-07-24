const { identityService } = require('../util')

const graphql = {
  server: {
    graphql: {
      opName: () => 'graphql.server.request',
      serviceName: identityService
    }
  }
}

module.exports = graphql
