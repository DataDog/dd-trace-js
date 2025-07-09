'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  send: {
    v0: {
      opName: 'amqp.send',
      serviceName: 'test-amqp-producer'
    },
    v1: {
      opName: 'amqp.send',
      serviceName: 'test'
    }
  },
  receive: {
    v0: {
      opName: 'amqp.receive',
      serviceName: 'test'
    },
    v1: {
      opName: 'amqp.process',
      serviceName: 'test'
    }
  }
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema)
}
