'use strict'

/* eslint-disable eslint-rules/eslint-process-env */

/**
 * @typedef {object} SupportedConfigurationEntry
 * @property {string} implementation
 * @property {string} type
 * @property {string|number|boolean|null|object|unknown[]} default
 * @property {string[]} [aliases]
 * @property {string[]} [configurationNames]
 * @property {string|boolean} [deprecated]
 */

/**
 * @typedef {object} SupportedConfigurationsJson
 * @property {Record<`DD_${string}` | `OTEL_${string}`, SupportedConfigurationEntry[]>} supportedConfigurations
 */

const { deprecate } = require('util')
const {
  supportedConfigurations,
} = /** @type {SupportedConfigurationsJson} */ (require('./supported-configurations.json'))

/**
 * Types for environment variable handling.
 *
 * @typedef {keyof typeof supportedConfigurations} SupportedEnvKey
 * @typedef {Partial<typeof process.env> & Partial<Record<SupportedEnvKey, string|undefined>>} TracerEnv
 */

// Backwards-compatible views for old helper logic:
// - `aliases`: Record<canonicalEnvVar, string[]>
// - `deprecations`: Record<deprecatedEnvVar, string> (message suffix)
const aliases = {}
const deprecations = {}

for (const [canonical, configuration] of Object.entries(supportedConfigurations)) {
  for (const implementation of configuration) {
    if (implementation.deprecated) {
      deprecations[canonical] = implementation.deprecated
      // Deprecated entries with an alias may not be listed in the supported configurations map
      if (implementation.aliases) {
        delete supportedConfigurations[canonical]
        continue
      }
    }
    if (Array.isArray(implementation.aliases)) {
      for (const alias of implementation.aliases) {
        aliases[canonical] ??= new Set()
        aliases[canonical].add(alias)
      }
    }
  }
}

// Backward-compatible aliases that are still supported at runtime but are not
// currently represented in supported-configurations metadata.
const legacyAliases = {
  DD_AGENT_HOST: ['DD_TRACE_AGENT_HOSTNAME'],
  DD_TRACE_AGENT_URL: ['DD_TRACE_URL'],
}

for (const [canonical, entries] of Object.entries(legacyAliases)) {
  aliases[canonical] ??= new Set()
  for (const alias of entries) {
    aliases[canonical].add(alias)
  }
}

const aliasToCanonical = {}
for (const canonical of Object.keys(aliases)) {
  for (const alias of aliases[canonical]) {
    if (aliasToCanonical[alias]) {
      throw new Error(`The alias ${alias} is already used for ${aliasToCanonical[alias]}.`)
    }
    aliasToCanonical[alias] = canonical
  }
}

const deprecationMethods = {}
for (const deprecation of Object.keys(deprecations)) {
  deprecationMethods[deprecation] = deprecate(
    () => {},
    `The environment variable ${deprecation} is deprecated.` +
    (aliasToCanonical[deprecation]
      ? ` Please use ${aliasToCanonical[deprecation]} instead.`
      : ` ${deprecations[deprecation]}`),
    `DATADOG_${deprecation}`
  )
}

let localStableConfig
let fleetStableConfig
let stableConfigWarnings
let stableConfigLoaded = false

function loadStableConfig () {
  stableConfigLoaded = true

  // Lazy require to avoid circular dependency at module load time.
  const { IS_SERVERLESS } = require('../serverless')
  if (IS_SERVERLESS) {
    // Stable config is not supported in serverless environments.
    return
  }

  const StableConfig = require('./stable')
  const instance = new StableConfig()
  localStableConfig = instance.localEntries
  fleetStableConfig = instance.fleetEntries
  stableConfigWarnings = instance.warnings
}

function getValueFromSource (name, source) {
  const value = source[name]

  if (value === undefined && aliases[name]) {
    for (const alias of aliases[name]) {
      if (source[alias] !== undefined) {
        return source[alias]
      }
    }
  }

  return value
}

function validateAccess (name) {
  if ((name.startsWith('DD_') || name.startsWith('OTEL_') || aliasToCanonical[name]) &&
    !supportedConfigurations[name]) {
    throw new Error(`Missing ${name} env/configuration in "supported-configurations.json" file.`)
  }
}

/**
 * Parses a comma separated list of items into an array of key value pairs.
 *
 * @param {string} value
 * @returns {string[]}
 */
function parseArray (value) {
  return value.split(',').map(item => {
    const colonIndex = item.indexOf(':')
    if (colonIndex === -1) {
      return item.trim()
    }
    const key = item.slice(0, colonIndex).trim()
    const val = item.slice(colonIndex + 1).trim()
    return val === undefined ? key : `${key}:${val}`
  })
}

module.exports = {
  /**
   * Expose raw stable config maps and warnings for consumers that need
   * per-source access (e.g. telemetry in Config).
   *
   * @returns {{ localStableConfig: object, fleetStableConfig: object, stableConfigWarnings: string[] }}
   */
  getStableConfigSources () {
    if (!stableConfigLoaded) {
      loadStableConfig()
    }
    return {
      localStableConfig,
      fleetStableConfig,
      stableConfigWarnings,
    }
  },
  /**
   * Returns the environment variables that are supported by the tracer
   * (including all non-Datadog/OTEL specific environment variables).
   *
   * This should only be called once in config.js to avoid copying the object frequently.
   *
   * @returns {TracerEnv} The environment variables
   */
  getEnvironmentVariables () {
    const configs = {}
    for (const [key, value] of Object.entries(process.env)) {
      // TODO(BridgeAR): Handle telemetry reporting for aliases.
      if (key.startsWith('DD_') || key.startsWith('OTEL_') || aliasToCanonical[key]) {
        if (supportedConfigurations[key]) {
          configs[key] = value
        } else if (aliasToCanonical[key] && configs[aliasToCanonical[key]] === undefined) {
          // The alias should only be used if the actual configuration is not set
          // In case that more than a single alias exist, use the one defined first in our own order
          for (const alias of aliases[aliasToCanonical[key]]) {
            if (process.env[alias] !== undefined) {
              configs[aliasToCanonical[key]] = value
              break
            }
          }
        // TODO(BridgeAR) Implement logging. It would have to use a timeout to
        // lazily log the message after all loading being done otherwise.
        //   debug(
        //     `Missing configuration ${env} in supported-configurations file. The environment variable is ignored.`
        //   )
        }
        deprecationMethods[key]?.()
      } else {
        configs[key] = value
      }
    }
    return configs
  },

  getEnvironmentVariable (name) {
    validateAccess(name)
    return getValueFromSource(name, process.env)
  },

  /**
   * Returns the value stored at the given name, assumed to be in environment variable format,
   * from the supported env sources (process.env, local stable config, fleet stable config).
   * Falls back to aliases if the canonical name is not set.
   *
   * @param {string} name Environment variable name
   * @returns {string|undefined}
   * @throws {Error} if the configuration is not supported
   */
  getValueFromEnvSources (name) {
    validateAccess(name)

    if (!stableConfigLoaded) {
      loadStableConfig()
    }

    if (fleetStableConfig !== undefined) {
      const fromFleet = getValueFromSource(name, fleetStableConfig)
      if (fromFleet !== undefined) {
        return fromFleet
      }
    }

    const fromEnv = getValueFromSource(name, process.env)
    if (fromEnv !== undefined) {
      return fromEnv
    }

    if (localStableConfig !== undefined) {
      return getValueFromSource(name, localStableConfig)
    }
  },
  parseArray,
}
