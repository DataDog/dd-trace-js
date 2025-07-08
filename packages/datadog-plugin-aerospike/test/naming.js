'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  command: {
    v0: {
      opName: 'aerospike.command',
      serviceName: 'test-aerospike'
    },
    v1: {
      opName: 'aerospike.command',
      serviceName: 'test'
    }
  }
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema)
}
