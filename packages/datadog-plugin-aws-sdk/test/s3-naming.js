'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  outbound: {
    v0: {
      serviceName: () => 'test-aws-s3',
      opName: () => 'aws.request'
    },
    v1: {
      serviceName: () => 'test',
      opName: () => 'aws.s3.request'
    }
  }
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema)
}
