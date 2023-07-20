const { identityService } = require('../util')

const graphql = {
  server: {
    graphql: {
      opName: () => 'graphql.execute',
      serviceName: identityService
    }
  }
}

module.exports = graphql
