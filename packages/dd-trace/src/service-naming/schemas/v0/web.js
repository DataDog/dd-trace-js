const { identityService, httpPluginClientService, awsServiceV0 } = require('../util')
const { DD_MAJOR } = require('../../../../../../version')

const web = {
  client: {
    grpc: {
      opName: () => DD_MAJOR <= 2 ? 'grpc.request' : 'grpc.client',
      serviceName: identityService
    },
    moleculer: {
      opName: () => 'moleculer.call',
      serviceName: identityService
    },
    http: {
      opName: () => 'http.request',
      serviceName: httpPluginClientService
    },
    fetch: {
      opName: () => 'http.request',
      serviceName: httpPluginClientService
    },
    http2: {
      opName: () => 'http.request',
      serviceName: httpPluginClientService
    },
    aws: {
      opName: () => 'aws.request',
      serviceName: awsServiceV0
    },
    lambda: {
      opName: () => 'aws.request',
      serviceName: awsServiceV0
    }
  },
  server: {
    grpc: {
      opName: () => DD_MAJOR <= 2 ? 'grpc.request' : 'grpc.server',
      serviceName: identityService
    },
    moleculer: {
      opName: () => 'moleculer.action',
      serviceName: identityService
    },
    http: {
      opName: () => 'web.request',
      serviceName: identityService
    },
    http2: {
      opName: () => 'web.request',
      serviceName: identityService
    },
    next: {
      opName: () => 'next.request',
      serviceName: identityService
    }
  }
}

module.exports = web
