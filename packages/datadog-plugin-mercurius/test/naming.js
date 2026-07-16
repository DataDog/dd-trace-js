'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

// The mercurius top-level span shares the `graphql` integration identity but is
// the request operation, not execute. v0 keeps the cross-tracer `graphql.request`
// name; v1 uses the schema-versioned `graphql.server.request`.
const rawExpectedSchema = {
  server: {
    v0: {
      opName: 'graphql.request',
      serviceName: 'test',
    },
    v1: {
      opName: 'graphql.server.request',
      serviceName: 'test',
    },
  },
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema),
}
