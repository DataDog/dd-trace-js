const { identityService, httpPluginClientService, awsServiceV0 } = require('../util')
const { DD_MAJOR } = require('../../../../../../version')

function withTracerV2Suffix (argsObj, fn, suffix) {
  const { tracerService } = argsObj
  if (DD_MAJOR <= 2) {
    return fn({ ...argsObj, tracerService: `${tracerService}${suffix}` })
  }
  return fn(argsObj)
}

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
      serviceName: argsObj => withTracerV2Suffix(argsObj, httpPluginClientService, '-http-client')
    },
    fetch: {
      opName: () => 'http.request',
      serviceName: argsObj => withTracerV2Suffix(argsObj, httpPluginClientService, '-http-client')
    },
    http2: {
      opName: () => 'http.request',
      serviceName: argsObj => withTracerV2Suffix(argsObj, httpPluginClientService, '-http-client')
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
      opName: () => DD_MAJOR <= 2 ? 'http.request' : 'web.request',
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
