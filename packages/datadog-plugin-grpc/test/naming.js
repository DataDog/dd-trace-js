'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  client: {
    v0: {
      opName: 'grpc.client',
      serviceName: 'test'
    },
    v1: {
      opName: 'grpc.client.request',
      serviceName: 'test'
    }
  },
  server: {
    v0: {
      opName: 'grpc.server',
      serviceName: 'test'
    },
    v1: {
      opName: 'grpc.server.request',
      serviceName: 'test'
    }
  }
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema)
}
