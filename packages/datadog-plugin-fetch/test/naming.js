'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  client: {
    v0: {
      serviceName: 'test',
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
