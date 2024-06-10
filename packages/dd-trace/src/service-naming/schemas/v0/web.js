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
