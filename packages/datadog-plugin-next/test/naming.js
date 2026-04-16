'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  server: {
    v0: {
      serviceName: () => 'test',
      opName: () => 'next.request',
      defaultTracerService: 'test',
    },
    v1: {
      serviceName: () => 'test',
      opName: () => 'http.server.request',
      defaultTracerService: 'test',
    },
  },
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema),
}
