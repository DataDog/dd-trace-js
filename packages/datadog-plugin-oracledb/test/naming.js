'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  outbound: {
    v0: {
      opName: 'oracle.query',
      serviceName: 'test-oracle',
    },
    v1: {
      opName: 'oracle.query',
      serviceName: 'test',
    },
  },
  poolAcquire: {
    v0: {
      opName: 'oracle.pool.acquire',
      serviceName: 'test-oracle',
    },
    v1: {
      opName: 'oracle.pool.acquire',
      serviceName: 'test',
    },
  },
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema),
}
