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
    },
    undici: {
      opName: () => 'undici.request',
      serviceName: httpPluginClientService
    }
  },
  server: {
    'apollo.gateway.request': {
      opName: () => 'apollo.gateway.request',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService
    },
    'apollo.gateway.plan': {
      opName: () => 'apollo.gateway.plan',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService
    },
    'apollo.gateway.validate': {
      opName: () => 'apollo.gateway.validate',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService
    },
    'apollo.gateway.execute': {
      opName: () => 'apollo.gateway.execute',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService
    },
    'apollo.gateway.fetch': {
      opName: () => 'apollo.gateway.fetch',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService
    },
    'apollo.gateway.postprocessing': {
      opName: () => 'apollo.gateway.postprocessing',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService
    },
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
