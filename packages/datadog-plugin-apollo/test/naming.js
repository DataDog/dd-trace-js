'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  server: {
    v0: {
      opName: 'apollo.gateway.request',
      serviceName: 'test'
    },
    v1: {
      opName: 'apollo.gateway.request',
      serviceName: 'test'
    }
  }
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema)
}
