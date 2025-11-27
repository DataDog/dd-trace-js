'use strict'

const {
  identityService, httpPluginClientService, awsServiceV0,
  optionServiceSource, awsServiceSource,
} = require('../util')

const web = {
  client: {
    grpc: {
      opName: () => 'grpc.client',
      serviceName: identityService,
    },
    moleculer: {
      opName: () => 'moleculer.call',
      serviceName: identityService,
    },
    http: {
      opName: () => 'http.request',
      serviceName: httpPluginClientService,
      serviceSource: optionServiceSource,
    },
    fetch: {
      opName: () => 'http.request',
      serviceName: httpPluginClientService,
      serviceSource: optionServiceSource,
    },
    http2: {
      opName: () => 'http.request',
      serviceName: httpPluginClientService,
      serviceSource: optionServiceSource,
    },
    genai: {
      opName: () => 'google_genai.request',
      serviceName: ({ pluginConfig, tracerService }) => pluginConfig.service || tracerService,
      serviceSource: optionServiceSource,
    },
    'modelcontextprotocol-sdk': {
      opName: () => 'mcp.tool.call',
      serviceName: ({ pluginService, tracerService }) => pluginService || tracerService,
    },
    aws: {
      opName: () => 'aws.request',
      serviceName: awsServiceV0,
      serviceSource: awsServiceSource,
    },
    lambda: {
      opName: () => 'aws.request',
      serviceName: awsServiceV0,
      serviceSource: awsServiceSource,
    },
    undici: {
      opName: () => 'undici.request',
      serviceName: httpPluginClientService,
      serviceSource: optionServiceSource,
    },
    'electron:net:fetch': {
      opName: () => 'http.request',
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
      opName: () => 'grpc.server',
      serviceName: identityService,
    },
    moleculer: {
      opName: () => 'moleculer.action',
      serviceName: identityService,
    },
    http: {
      opName: () => 'web.request',
      serviceName: identityService,
    },
    http2: {
      opName: () => 'web.request',
      serviceName: identityService,
    },
    next: {
      opName: () => 'next.request',
      serviceName: identityService,
    },
  },
}

module.exports = web
