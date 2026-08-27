'use strict'

/** @typedef {import('../plugins/tracing').NamingOptions} NamingOptions */

/**
 * @param {string} tracerService
 * @returns {string}
 */
function identityService (tracerService) {
  return tracerService
}

/** @returns {undefined} */
function noServiceSource () {}

/**
 * @param {string} tracerService
 * @param {NamingOptions} options
 * @returns {string}
 */
function configuredService (tracerService, { pluginConfig } = {}) {
  const service = pluginConfig?.service
  return typeof service === 'string' && service ? service : tracerService
}

/**
 * @param {string} tracerService
 * @param {NamingOptions} options
 * @returns {string | undefined}
 */
function optionServiceSource (tracerService, { pluginConfig } = {}) {
  if (pluginConfig?.splitByDomain) {
    return 'opt.split_by_domain'
  }

  if (pluginConfig?.service) {
    return 'opt.plugin'
  }
}

/**
 * @param {string} integration
 * @returns {(tracerService: string, options: NamingOptions) => string}
 */
function integrationService (integration) {
  return function integrationServiceName (tracerService) {
    return `${tracerService}-${integration}`
  }
}

/**
 * @param {string} integration
 * @returns {(tracerService: string, options: NamingOptions) => string}
 */
function configuredIntegrationService (integration) {
  return function getConfiguredIntegrationService (tracerService, { pluginConfig } = {}) {
    const service = pluginConfig?.service
    return typeof service === 'string' && service ? service : `${tracerService}-${integration}`
  }
}

/**
 * @param {string} integration
 * @returns {(tracerService: string, options: NamingOptions) => string}
 */
function integrationServiceSource (integration) {
  return function getIntegrationServiceSource () {
    return integration
  }
}

/**
 * @param {string} tracerService
 * @param {NamingOptions} options
 * @returns {string | undefined}
 */
function serviceFromSystem (tracerService, { system } = {}) {
  return system ? `${tracerService}-${system}` : undefined
}

/**
 * @param {string} tracerService
 * @param {NamingOptions} options
 * @returns {string | undefined}
 */
function configuredSystemService (tracerService, { pluginConfig, system } = {}) {
  const service = pluginConfig?.service
  return typeof service === 'string' && service ? service : serviceFromSystem(tracerService, { system })
}

/**
 * @param {string} tracerService
 * @param {NamingOptions} options
 * @returns {string | undefined}
 */
function configuredInstanceService (tracerService, { connectionName, pluginConfig = {}, system } = {}) {
  let service = pluginConfig.service
  if (pluginConfig.splitByInstance && connectionName) {
    service = typeof service === 'string' && service ? `${service}-${connectionName}` : connectionName
  }

  return typeof service === 'string' && service ? service : serviceFromSystem(tracerService, { system })
}

/**
 * @param {string} tracerService
 * @param {NamingOptions} options
 * @returns {string | undefined}
 */
function configuredDatabaseService (tracerService, { dbConfig, pluginConfig, system } = {}) {
  if (typeof pluginConfig?.service === 'function') {
    return pluginConfig.service(dbConfig)
  }
  return pluginConfig?.service || serviceFromSystem(tracerService, { system })
}

/**
 * @param {string} tracerService
 * @param {NamingOptions} options
 * @returns {string}
 */
function configuredServiceWithFunction (tracerService, { params, pluginConfig } = {}) {
  return configServiceName(pluginConfig, params, tracerService)
}

/**
 * @param {string} integration
 * @returns {(tracerService: string, options: NamingOptions) => string}
 */
function storageServiceSource (integration) {
  return function getStorageServiceSource (tracerService, { connectionName, pluginConfig } = {}) {
    if (pluginConfig?.splitByInstance && connectionName) {
      return 'opt.split_by_instance'
    }

    return pluginConfig?.service ? 'opt.plugin' : integration
  }
}

/**
 * @param {string} tracerService
 * @param {NamingOptions} options
 * @returns {string}
 */
function httpPluginClientService (tracerService, { pluginConfig = {}, sessionDetails = {} } = {}) {
  if (pluginConfig.splitByDomain) {
    const { host, port } = sessionDetails
    if (host) {
      return port ? `${host}:${port}` : host
    }
    return port ? String(port) : ''
  }

  const service = pluginConfig.service
  return typeof service === 'string' && service ? service : tracerService
}

/**
 * @param {import('../plugins/tracing').NamingPluginConfig | undefined} pluginConfig
 * @param {object | undefined} params
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

/**
 * @param {string} tracerService
 * @param {NamingOptions} options
 * @returns {string}
 */
function awsServiceV0 (tracerService, { pluginConfig, params, awsService } = {}) {
  return configServiceName(pluginConfig, params, `${tracerService}-aws-${awsService}`)
}

/**
 * @param {string} tracerService
 * @param {NamingOptions} options
 * @returns {string}
 */
function awsServiceV1 (tracerService, { pluginConfig, params } = {}) {
  return configServiceName(pluginConfig, params, tracerService)
}

/**
 * @param {string} tracerService
 * @param {NamingOptions} options
 * @returns {string | undefined}
 */
function awsServiceSource (tracerService, { awsService, pluginConfig } = {}) {
  return pluginConfig?.service ? 'opt.plugin' : awsService
}

module.exports = {
  awsServiceSource,
  awsServiceV0,
  awsServiceV1,
  configServiceName,
  configuredDatabaseService,
  configuredIntegrationService,
  configuredInstanceService,
  configuredService,
  configuredServiceWithFunction,
  configuredSystemService,
  httpPluginClientService,
  identityService,
  integrationService,
  integrationServiceSource,
  noServiceSource,
  optionServiceSource,
  serviceFromSystem,
  storageServiceSource,
}
