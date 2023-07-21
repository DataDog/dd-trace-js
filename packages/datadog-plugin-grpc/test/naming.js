const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')
const { DD_MAJOR } = require('../../../version')

const rawExpectedSchema = {
  client: {
    v0: {
      opName: DD_MAJOR <= 2 ? 'grpc.request' : 'grpc.client',
      serviceName: 'test'
    },
    v1: {
      opName: 'grpc.client.request',
      serviceName: 'test'
    }
  },
  server: {
    v0: {
      opName: DD_MAJOR <= 2 ? 'grpc.request' : 'grpc.server',
      serviceName: 'test'
    },
    v1: {
      opName: 'grpc.server.request',
      serviceName: 'test'
    }
  }
}

module.exports = {
  rawExpectedSchema: rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema)
}
