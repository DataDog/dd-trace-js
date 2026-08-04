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

/**
 * Resolve a `service` config that may be a string or a function. A string
 * overrides every span; a function is called with the request params so a
 * single resource can be mapped to its own service, and only a non-empty
 * string result is honored — anything else falls back to `defaultService`.
 *
 * @param {{ service?: string | ((params?: object) => unknown) }} [pluginConfig]
 * @param {object} [params]
 * @param {string} defaultService
 * @returns {string}
 */
function configServiceName (pluginConfig, params, defaultService) {
  const service = pluginConfig?.service
  if (typeof service === 'function') {
    const custom = service(params)
    return typeof custom === 'string' && custom ? custom : defaultService
  }
  return service || defaultService
}

function awsServiceV0 ({ tracerService, pluginConfig, params, awsService }) {
  return configServiceName(pluginConfig, params, `${tracerService}-aws-${awsService}`)
}

function awsServiceV1 ({ tracerService, pluginConfig, params }) {
  return configServiceName(pluginConfig, params, tracerService)
}

function awsServiceSource ({ awsService, pluginConfig }) {
  return pluginConfig?.service ? 'opt.plugin' : awsService
}

module.exports = {
  identityService,
  httpPluginClientService,
  awsServiceV0,
  awsServiceV1,
  optionServiceSource,
  awsServiceSource,
}
