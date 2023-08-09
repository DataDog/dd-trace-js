const { identityService, httpPluginClientService } = require('../util')

const web = {
  client: {
    grpc: {
      opName: () => 'grpc.client.request',
      serviceName: identityService
    },
    moleculer: {
      opName: () => 'moleculer.client.request',
      serviceName: identityService
    },
    http: {
      opName: () => 'http.client.request',
      serviceName: httpPluginClientService
    },
    fetch: {
      opName: () => 'http.client.request',
      serviceName: httpPluginClientService
    },
    http2: {
      opName: () => 'http.client.request',
      serviceName: httpPluginClientService
    },
    aws: {
      opName: ({ awsService }) => `aws.${awsService}.request`,
      serviceName: identityService
    },
    lambda: {
      opName: () => 'aws.lambda.invoke',
      serviceName: identityService
    }
  },
  server: {
    grpc: {
      opName: () => 'grpc.server.request',
      serviceName: identityService
    },
    moleculer: {
      opName: () => 'moleculer.server.request',
      serviceName: identityService
    },
    http: {
      opName: () => 'http.server.request',
      serviceName: identityService
    },
    http2: {
      opName: () => 'http.server.request',
      serviceName: identityService
    },
    next: {
      opName: () => 'http.server.request',
      serviceName: identityService
    }
  }
}

module.exports = web
