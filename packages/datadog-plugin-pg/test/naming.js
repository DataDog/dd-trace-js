'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  outbound: {
    v0: {
      opName: 'pg.query',
      serviceName: 'test-postgres',
    },
    v1: {
      opName: 'postgresql.query',
      serviceName: 'test',
    },
  },
  poolAcquire: {
    v0: {
      opName: 'pg.pool.acquire',
      serviceName: 'test-postgres',
    },
    v1: {
      opName: 'postgresql.pool.acquire',
      serviceName: 'test',
    },
  },
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema),
}
