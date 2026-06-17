'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  outbound: {
    v0: {
      opName: 'rethinkdb.query',
      serviceName: 'test-rethinkdb',
    },
    v1: {
      opName: 'rethinkdb.query',
      serviceName: 'test',
    },
  },
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema),
}
