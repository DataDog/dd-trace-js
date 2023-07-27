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
  }
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema)
}
