'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  server: {
    v0: {
      serviceName: () => 'test',
      opName: () => 'next.request'
    },
    v1: {
      serviceName: () => 'test',
      opName: () => 'http.server.request'
    }
  }
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema)
}
