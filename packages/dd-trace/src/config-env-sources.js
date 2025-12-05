'use strict'

const { isInServerlessEnvironment } = require('./serverless')
const { getValueFromEnvSource, getEnvironmentVariable } = require('./config-helper')

class ConfigEnvSources {
  constructor () {
    const isServerless = isInServerlessEnvironment()

    let localStableConfig = {}
    let fleetStableConfig = {}
    let stableConfigWarnings = []

    if (!isServerless) {
      const result = this.#loadStableConfig()
      if (result) {
        localStableConfig = result.localEntries
        fleetStableConfig = result.fleetEntries
        stableConfigWarnings = result.warnings
      }
    }

    // Expose raw stable config on the instance
    this.localStableConfig = localStableConfig
    this.fleetStableConfig = fleetStableConfig
    this.stableConfigWarnings = stableConfigWarnings
  }

  #loadStableConfig () {
    try {
      const StableConfig = require('./config_stable')
      const instance = new StableConfig()
      return {
        localEntries: instance.localEntries ?? {},
        fleetEntries: instance.fleetEntries ?? {},
        warnings: instance.warnings ?? []
      }
    } catch {
      // Stable config is optional, continue without it
      return null
    }
  }
}

function createConfigEnvSources () {
  return new ConfigEnvSources()
}

let configEnvSourcesInstance = null

function getConfigEnvSources () {
  if (!configEnvSourcesInstance) {
    configEnvSourcesInstance = new ConfigEnvSources()
  }
  return configEnvSourcesInstance
}

/**
 * Reset the singleton instance (useful for testing)
 */
function resetConfigEnvSources () {
  configEnvSourcesInstance = null
}

/**
 * Returns the resolved configuration value from ConfigEnvSources. Falls back to aliases if the
 * canonical name is not set. Throws an error if the configuration is not supported.
 *
 * @param {string} name Environment variable name
 * @returns {string|undefined}
 * @throws {Error} if the configuration is not supported
 */
function getResolvedEnv (name) {
  const config = getConfigEnvSources()
  if (getValueFromEnvSource(name, config.fleetStableConfig) !== undefined) {
    return getValueFromEnvSource(name, config.fleetStableConfig)
  }
  if (getEnvironmentVariable(name) !== undefined) {
    return getEnvironmentVariable(name)
  }
  if (getValueFromEnvSource(name, config.localStableConfig) !== undefined) {
    return getValueFromEnvSource(name, config.localStableConfig)
  }
}

module.exports = {
  ConfigEnvSources,
  createConfigEnvSources,
  getConfigEnvSources,
  resetConfigEnvSources,
  getResolvedEnv
}
