'use strict'

function identityService ({ tracerService }) {
  return tracerService
}

function getFormattedHostString ({ host, port }) {
  return [host, port].filter(Boolean).join(':')
}

function httpPluginClientService ({ tracerService, pluginConfig, sessionDetails }) {
  if (pluginConfig.splitByDomain) {
    return getFormattedHostString(sessionDetails)
  } else if (pluginConfig.service) {
    return pluginConfig.service
  }

  return tracerService
}

function optionServiceSource ({ pluginConfig }) {
  if (pluginConfig.splitByDomain) {
    return 'opt.split_by_domain'
  }

  if (pluginConfig.service) {
    return 'opt.plugin'
  }
}

function awsServiceV0 ({ tracerService, awsService }) {
  return `${tracerService}-aws-${awsService}`
}

function awsServiceSource ({ awsService }) {
  return awsService
}

module.exports = { identityService, httpPluginClientService, awsServiceV0, optionServiceSource, awsServiceSource }
