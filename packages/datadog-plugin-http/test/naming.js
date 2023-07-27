const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')
const { DD_MAJOR } = require('../../../version')

const rawExpectedSchema = {
  client: {
    v0: {
      serviceName: DD_MAJOR <= 2 ? 'test-http-client' : 'test',
      opName: 'http.request'
    },
    v1: {
      serviceName: 'test',
      opName: 'http.client.request'
    }
  },
  server: {
    v0: {
      serviceName: 'test',
      opName: DD_MAJOR <= 2 ? 'http.request' : 'web.request'
    },
    v1: {
      serviceName: 'test',
      opName: 'http.server.request'
    }
  }
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema)
}
