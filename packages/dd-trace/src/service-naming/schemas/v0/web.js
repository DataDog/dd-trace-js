'use strict'

const { identityService, httpPluginClientService, awsServiceV0 } = require('../util')

function apolloServiceName (opts) {
  const { pluginConfig, tracerService } = opts
  if (pluginConfig.service) {
    opts.srvSrc = pluginConfig.serviceFromMapping ? 'opt.mapping' : 'm'
    return pluginConfig.service
  }
  return tracerService
}

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
    },
    fetch: {
      opName: () => 'http.request',
      serviceName: httpPluginClientService,
    },
    http2: {
      opName: () => 'http.request',
      serviceName: httpPluginClientService,
    },
    genai: {
      opName: () => 'google_genai.request',
      serviceName: (opts) => {
        const { pluginConfig, tracerService } = opts
        if (pluginConfig.service) {
          opts.srvSrc = pluginConfig.serviceFromMapping ? 'opt.mapping' : 'm'
          return pluginConfig.service
        }
        return tracerService
      },
    },
    aws: {
      opName: () => 'aws.request',
      serviceName: awsServiceV0,
    },
    lambda: {
      opName: () => 'aws.request',
      serviceName: awsServiceV0,
    },
    undici: {
      opName: () => 'undici.request',
      serviceName: httpPluginClientService,
    },
  },
  server: {
    'apollo.gateway.request': {
      opName: () => 'apollo.gateway.request',
      serviceName: apolloServiceName,
    },
    'apollo.gateway.plan': {
      opName: () => 'apollo.gateway.plan',
      serviceName: apolloServiceName,
    },
    'apollo.gateway.validate': {
      opName: () => 'apollo.gateway.validate',
      serviceName: apolloServiceName,
    },
    'apollo.gateway.execute': {
      opName: () => 'apollo.gateway.execute',
      serviceName: apolloServiceName,
    },
    'apollo.gateway.fetch': {
      opName: () => 'apollo.gateway.fetch',
      serviceName: apolloServiceName,
    },
    'apollo.gateway.postprocessing': {
      opName: () => 'apollo.gateway.postprocessing',
      serviceName: apolloServiceName,
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
