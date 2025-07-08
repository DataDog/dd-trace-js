'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  send: {
    v0: {
      opName: 'kafka.produce',
      serviceName: 'test-kafka'
    },
    v1: {
      opName: 'kafka.send',
      serviceName: 'test'
    }
  },
  receive: {
    v0: {
      opName: 'kafka.consume',
      serviceName: 'test-kafka'
    },
    v1: {
      opName: 'kafka.process',
      serviceName: 'test'
    }
  }
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema)
}
