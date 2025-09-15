'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  client: {
    v0: {
      opName: 'prisma.client',
      serviceName: 'test-prisma'
    },
    v1: {
      opName: 'prisma.client',
      serviceName: 'test'
    }
  },
  engine: {
    v0: {
      opName: 'prisma.engine',
      serviceName: 'test-prisma'
    },
    v1: {
      opName: 'prisma.engine',
      serviceName: 'test'
    }
  }
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema)
}
