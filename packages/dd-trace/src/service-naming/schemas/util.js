function identityService ({ tracerService }) {
  return tracerService
}

function getFormattedHostString ({ host, port }) {
  return [host, port].filter(val => val).join(':')
}

function httpPluginClientService ({ tracerService, pluginConfig, sessionDetails }) {
  if (pluginConfig.splitByDomain) {
    return getFormattedHostString(sessionDetails)
  } else if (pluginConfig.service) {
    return pluginConfig.service
  }

  return tracerService
}

function awsServiceV0 ({ tracerService, awsService }) {
  return `${tracerService}-aws-${awsService}`
}

module.exports = { identityService, httpPluginClientService, awsServiceV0 }
