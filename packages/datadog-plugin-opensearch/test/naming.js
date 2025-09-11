'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  outbound: {
    v0: {
      opName: 'opensearch.query',
      serviceName: 'test-opensearch'
    },
    v1: {
      opName: 'opensearch.query',
      serviceName: 'test'
    }
  }
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema)
}
