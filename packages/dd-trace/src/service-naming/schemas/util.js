'use strict'

function identityService ({ tracerService }) {
  return tracerService
}

function getFormattedHostString ({ host, port }) {
  return [host, port].filter(Boolean).join(':')
}

function httpPluginClientService (opts) {
  const { tracerService, pluginConfig, sessionDetails } = opts
  if (pluginConfig.splitByDomain) {
    opts.srvSrc = 'http'
    return getFormattedHostString(sessionDetails)
  } else if (pluginConfig.service) {
    opts.srvSrc = pluginConfig.serviceFromMapping ? 'opt.mapping' : 'm'
    return pluginConfig.service
  }

  return tracerService
}

function awsServiceV0 (opts) {
  const { tracerService, awsService } = opts
  opts.srvSrc = 'aws'
  return `${tracerService}-aws-${awsService}`
}

module.exports = { identityService, httpPluginClientService, awsServiceV0 }
