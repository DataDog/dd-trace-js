'use strict'

const { identityService } = require('../util')

const graphql = {
  server: {
    graphql: {
      opName: () => 'graphql.server.request',
      serviceName: identityService,
    },
    // Top-level request span for drivers that funnel through a single entry
    // point (mercurius). Matches the cross-tracer `graphql.server.request` v1
    // name. The v1 overlap with the execute span's name above is a known wart
    // tracked for a separate cross-tracer unification (breaking) change.
    request: {
      opName: () => 'graphql.server.request',
      serviceName: identityService,
    },
  },
}

module.exports = graphql
