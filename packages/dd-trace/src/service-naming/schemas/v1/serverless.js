'use strict'

const { identityService } = require('../util')

const serverless = {
  server: {
    'azure-functions': {
      opName: () => 'azure.functions.invoke',
      serviceName: identityService,
    },
    'azure-durable-functions': {
      opName: () => 'azure.functions.invoke',
      serviceName: identityService,
    },
    'aws-durable-execution-sdk-js': {
      opName: () => 'aws.durable-execution.invoke',
      serviceName: identityService,
    },
  },
  client: {
    'aws-durable-execution-sdk-js': {
      opName: () => 'aws.durable-execution.invoke',
      serviceName: identityService,
    },
  },
  internal: {
    'aws-durable-execution-sdk-js': {
      opName: () => 'aws.durable-execution.invoke',
      serviceName: identityService,
    },
  },
}

module.exports = serverless
