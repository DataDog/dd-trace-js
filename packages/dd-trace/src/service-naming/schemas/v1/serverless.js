'use strict'

const { identityService } = require('../util')

const serverless = {
  server: {
    'azure-functions': {
      opName: () => 'azure.functions.invoke',
      serviceName: identityService,
    },
    'azure-durable-functions': {
      opName: () => 'azure.durable-functions.invoke',
      serviceName: identityService,
    },
  },
}

module.exports = serverless
