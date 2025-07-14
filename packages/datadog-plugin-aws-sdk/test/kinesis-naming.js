'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  outbound: {
    v0: {
      serviceName: () => 'test-aws-kinesis',
      opName: () => 'aws.request'
    },
    v1: {
      serviceName: () => 'test',
      opName: () => 'aws.kinesis.request'
    }
  }
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema)
}
