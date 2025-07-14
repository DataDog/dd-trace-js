'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  producer: {
    v0: {
      serviceName: () => 'test-aws-sns',
      opName: () => 'aws.request'
    },
    v1: {
      serviceName: () => 'test',
      opName: () => 'aws.sns.send'
    }
  },
  client: {
    v0: {
      serviceName: () => 'test-aws-sns',
      opName: () => 'aws.request'
    },
    v1: {
      serviceName: () => 'test',
      opName: () => 'aws.sns.request'
    }
  }
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema)
}
