'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  producer: {
    v0: {
      serviceName: () => 'test-aws-sqs',
      opName: () => 'aws.request'
    },
    v1: {
      serviceName: () => 'test',
      opName: () => 'aws.sqs.send'
    }
  },
  consumer: {
    v0: {
      serviceName: () => 'test-aws-sqs',
      opName: () => 'aws.request'
    },
    v1: {
      serviceName: () => 'test',
      opName: () => 'aws.sqs.process'
    }
  },
  client: {
    v0: {
      serviceName: () => 'test-aws-sqs',
      opName: () => 'aws.request'
    },
    v1: {
      serviceName: () => 'test',
      opName: () => 'aws.sqs.request'
    }
  }
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema)
}
