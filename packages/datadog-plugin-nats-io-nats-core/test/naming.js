'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  send: {
    v0: {
      opName: 'nats.publish',
      serviceName: 'test-nats'
    },
    v1: {
      opName: 'nats.send',
      serviceName: 'test'
    }
  },
  receive: {
    v0: {
      opName: 'nats.process',
      serviceName: 'test-nats'
    },
    v1: {
      opName: 'nats.process',
      serviceName: 'test'
    }
  },
  request: {
    v0: {
      opName: 'nats.request',
      serviceName: 'test-nats'
    },
    v1: {
      opName: 'nats.request',
      serviceName: 'test'
    }
  }
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema)
}
