'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  outbound: {
    v0: {
      opName: 'valkey.command',
      serviceName: 'test-valkey'
    },
    v1: {
      opName: 'valkey.command',
      serviceName: 'test'
    }
  }
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema)
}
