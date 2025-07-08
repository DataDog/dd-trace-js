'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  invoke: {
    v0: {
      serviceName: () => 'test-aws-lambda',
      opName: () => 'aws.request'
    },
    v1: {
      serviceName: () => 'test',
      opName: () => 'aws.lambda.invoke'
    }
  },
  client: {
    v0: {
      serviceName: () => 'test-aws-lambda',
      opName: () => 'aws.request'
    },
    v1: {
      serviceName: () => 'test',
      opName: () => 'aws.lambda.request'
    }
  }
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema)
}
