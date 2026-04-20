'use strict'

const { identityService, httpPluginClientService, optionServiceSource } = require('../util')

const web = {
  client: {
    grpc: {
      opName: () => 'grpc.client.request',
      serviceName: identityService,
    },
    moleculer: {
      opName: () => 'moleculer.client.request',
      serviceName: identityService,
    },
    http: {
      opName: () => 'http.client.request',
      serviceName: httpPluginClientService,
      serviceSource: optionServiceSource,
    },
    genai: {
      opName: () => 'google_genai.request',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService,
      serviceSource: optionServiceSource,
    },
    fetch: {
      opName: () => 'http.client.request',
      serviceName: httpPluginClientService,
      serviceSource: optionServiceSource,
    },
    http2: {
      opName: () => 'http.client.request',
      serviceName: httpPluginClientService,
      serviceSource: optionServiceSource,
    },
    aws: {
      opName: ({ awsService }) => `aws.${awsService}.request`,
      serviceName: identityService,
    },
    lambda: {
      opName: () => 'aws.lambda.invoke',
      serviceName: identityService,
    },
    undici: {
      opName: () => 'undici.request',
      serviceName: httpPluginClientService,
    },
  },
  server: {
    'apollo.gateway.request': {
      opName: () => 'apollo.gateway.request',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService,
      serviceSource: optionServiceSource,
    },
    'apollo.gateway.plan': {
      opName: () => 'apollo.gateway.plan',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService,
      serviceSource: optionServiceSource,
    },
    'apollo.gateway.validate': {
      opName: () => 'apollo.gateway.validate',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService,
      serviceSource: optionServiceSource,
    },
    'apollo.gateway.execute': {
      opName: () => 'apollo.gateway.execute',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService,
      serviceSource: optionServiceSource,
    },
    'apollo.gateway.fetch': {
      opName: () => 'apollo.gateway.fetch',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService,
      serviceSource: optionServiceSource,
    },
    'apollo.gateway.postprocessing': {
      opName: () => 'apollo.gateway.postprocessing',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService,
      serviceSource: optionServiceSource,
    },
    grpc: {
      opName: () => 'grpc.server.request',
      serviceName: identityService,
    },
    moleculer: {
      opName: () => 'moleculer.server.request',
      serviceName: identityService,
    },
    http: {
      opName: () => 'http.server.request',
      serviceName: identityService,
    },
    http2: {
      opName: () => 'http.server.request',
      serviceName: identityService,
    },
    next: {
      opName: () => 'http.server.request',
      serviceName: identityService,
    },
  },
}

module.exports = web
