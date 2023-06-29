function identityService (service) {
  return service
}

function getHost (options) {
  if (typeof options === 'string') {
    return new URL(options).host
  }

  const hostname = options.hostname || options.host || 'localhost'
  const port = options.port

  return [hostname, port].filter(val => val).join(':')
}

function httpPluginClientService (tracerService, pluginConfig, options) {
  if (pluginConfig.splitByDomain) {
    return getHost(options)
  } else if (pluginConfig.service) {
    return pluginConfig.service
  }

  return tracerService
}

module.exports = { identityService, httpPluginClientService }
