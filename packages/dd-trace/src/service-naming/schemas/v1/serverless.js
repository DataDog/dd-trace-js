'use strict'

const { identityService } = require('../util')

const serverless = {
  server: {
    'azure-functions': {
      opName: () => 'azure.functions.invoke',
      serviceName: identityService,
    },
    lambda: {
      opName: () => 'aws.lambda',
      serviceName: identityService,
    },
  },
}

module.exports = serverless
