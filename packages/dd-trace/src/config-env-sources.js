'use strict'

const { getEnvironmentVariables } = require('./config-helper')
const { isInServerlessEnvironment } = require('./serverless')

/**
 * ConfigEnvSources - Resolves configuration from stable config files and environment variables
 * This class loads and merges local stable config, environment variables, and fleet stable config
 * in the correct priority order BEFORE the main Config class is instantiated.
 *
 * Priority order (ascending):
 * 1. Local stable config (lowest priority)
 * 2. Environment variables (middle priority)
 * 3. Fleet/Managed stable config (highest priority)
 *
 */
class ConfigEnvSources {
  constructor () {
    const isServerless = isInServerlessEnvironment()

    let localStableConfig = {}
    let fleetStableConfig = {}

    if (!isServerless) {
      const result = this.#loadStableConfig()
      if (result) {
        localStableConfig = result.localEntries
        fleetStableConfig = result.fleetEntries
      }
    }

    const envVars = getEnvironmentVariables()

    Object.assign(this, localStableConfig)
    for (const [key, value] of Object.entries(envVars)) {
      if (value !== undefined) {
        this[key] = value
      }
    }

    for (const [key, value] of Object.entries(fleetStableConfig)) {
      if (value !== undefined) {
        this[key] = value
      }
    }
  }

  #loadStableConfig () {
    try {
      const StableConfig = require('./config_stable')
      const instance = new StableConfig()
      return {
        instance,
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
function getEnvironmentVariableSources (name) {
  const { supportedConfigurations, aliases } = require('./supported-configurations.json')
  const aliasToCanonical = {}
  for (const canonical of Object.keys(aliases)) {
    for (const alias of aliases[canonical]) {
      aliasToCanonical[alias] = canonical
    }
  }

  if ((name.startsWith('DD_') || name.startsWith('OTEL_') || aliasToCanonical[name]) &&
      !supportedConfigurations[name]) {
    throw new Error(`Missing ${name} env/configuration in "supported-configurations.json" file.`)
  }
  const config = getConfigEnvSources()
  const value = config[name]
  if (value === undefined && aliases[name]) {
    for (const alias of aliases[name]) {
      if (config[alias] !== undefined) {
        return config[alias]
      }
    }
  }
  return value
}

module.exports = {
  ConfigEnvSources,
  createConfigEnvSources,
  getConfigEnvSources,
  resetConfigEnvSources,
  getEnvironmentVariableSources
}
