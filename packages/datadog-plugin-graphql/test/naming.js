'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  server: {
    v0: {
      opName: 'graphql.execute',
      serviceName: 'test'
    },
    v1: {
      opName: 'graphql.server.request',
      serviceName: 'test'
    }
  }
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema)
}
