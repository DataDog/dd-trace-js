'use strict'

const { identityService } = require('../util')

const graphql = {
  server: {
    graphql: {
      opName: () => 'graphql.execute',
      serviceName: identityService,
    },
    // Top-level request span for drivers that funnel through a single entry
    // point (mercurius). Matches the cross-tracer `graphql.request` v0 name.
    request: {
      opName: () => 'graphql.request',
      serviceName: identityService,
    },
  },
}

module.exports = graphql
