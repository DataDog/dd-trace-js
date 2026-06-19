'use strict'

/* eslint-disable eslint-rules/eslint-process-env */

/**
 * @typedef {object} SupportedConfigurationEntry
 * @property {string} implementation
 * @property {string} type
 * @property {string|number|boolean|null|object|unknown[]} default
 * @property {string[]} [aliases]
 * @property {string[]} [configurationNames]
 * @property {string} [internalPropertyName]
 * @property {string} [transform]
 * @property {string} [allowed]
 * @property {string|boolean} [deprecated]
 * @property {boolean} [sensitive] Excludes the configuration value from configuration telemetry.
 */

/**
 * @typedef {object} SupportedConfigurationsJson
 * @property {Record<`DD_${string}` | `OTEL_${string}`, SupportedConfigurationEntry[]>} supportedConfigurations
 */

const { deprecate } = require('util')
const { DD_MAJOR } = require('../../../../version')
const applyMajorOverrides = require('./major-overrides')
const {
  supportedConfigurations,
} = /** @type {SupportedConfigurationsJson} */ (require('./supported-configurations.json'))

applyMajorOverrides(supportedConfigurations, DD_MAJOR)

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

const aliasToCanonical = {}
for (const canonical of Object.keys(aliases)) {
  for (const alias of aliases[canonical]) {
    if (supportedConfigurations[alias]) {
      // Allow 'fallback' aliases to be used for other configurations.
      // This is used to handle the case where an alias could be used for multiple configurations.
      // For example, OTEL_EXPORTER_OTLP_ENDPOINT is used for OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
      // and OTEL_EXPORTER_OTLP_METRICS_ENDPOINT.
      continue
    }
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
  if (source[name] !== undefined) {
    return source[name]
  }

  if (aliases[name]) {
    for (const alias of aliases[name]) {
      if (source[alias] !== undefined) {
        return source[alias]
      }
    }
  }
}

function getEnvNameFromSource (name, source) {
  if (source[name] !== undefined) {
    return name
  }

  if (aliases[name]) {
    for (const alias of aliases[name]) {
      if (source[alias] !== undefined) {
        return alias
      }
    }
  }
}

function validateAccess (name) {
  if ((name.startsWith('DD_') || name.startsWith('OTEL_')) &&
    !supportedConfigurations[name] &&
    !aliasToCanonical[name]) {
    throw new Error(`Missing ${name} env/configuration in "supported-configurations.json" file.`)
  }
}

let configurationsTable
let configDefaults

// Lazy require to keep the `config -> helper` import direction acyclic: helper
// must not pull `config/defaults` at module load. `config/defaults` defers its
// own instrumented `dns` require until after it exports, so by the time any
// caller resolves a value the table is fully populated.
function loadConfigurationsTable () {
  if (configurationsTable === undefined) {
    const defaultsModule = require('./defaults')
    configurationsTable = defaultsModule.configurationsTable
    configDefaults = defaultsModule.defaults
  }
}

/**
 * Parses and transforms a raw environment value with the same parser and
 * transformer Config applies when it reads environment sources, so callers
 * receive the typed value instead of the raw string.
 *
 * @param {string} name Canonical or alias environment variable name.
 * @param {string} value Raw value read from an environment source.
 * @param {'env_var'|'fleet_stable_config'|'local_stable_config'} source Source the value was read from.
 * @returns {string | number | boolean | object | undefined}
 */
function parseConfigurationValue (name, value, source) {
  loadConfigurationsTable()
  const canonical = aliasToCanonical[name] ?? name
  const entry = configurationsTable[canonical]
  const parsed = entry.parser(value, canonical, source)
  return parsed !== undefined && entry.transformer ? entry.transformer(parsed, canonical, source) : parsed
}

/**
 * Returns the registered default for a configuration — the same value Config
 * resolves when no environment source sets it.
 *
 * @param {string} name Canonical or alias environment variable name.
 * @returns {string | number | boolean | object | undefined}
 */
function getRegisteredDefault (name) {
  loadConfigurationsTable()
  const canonical = aliasToCanonical[name] ?? name
  const entry = configurationsTable[canonical]
  return configDefaults[entry.property ?? canonical]
}

/** @typedef {import('./generated-config-types').GeneratedEnvVarConfig} GeneratedEnvVarConfig */

/**
 * Returns the value stored at the given name, assumed to be in environment variable format,
 * from the supported env sources (process.env, local stable config, fleet stable config).
 * Falls back to aliases if the canonical name is not set.
 *
 * The raw value is parsed and transformed exactly as Config does when it reads environment
 * sources, so the returned value is typed (boolean, number, array, map, ...) rather than the
 * raw string. A literal supported name resolves to its specific configured type.
 *
 * When the name is not set in any source, the registered default is returned, so callers can
 * use the value directly. Callers that must distinguish an explicitly configured value from the
 * default (e.g. an OTel fallback that only applies when the option is unset) pass `skipDefault`
 * to receive `undefined` for an unset value instead. All sources (process.env, local and fleet
 * stable config) are read in both modes.
 *
 * @template {keyof GeneratedEnvVarConfig} TName
 * @overload
 * @param {TName} name Environment variable name
 * @returns {GeneratedEnvVarConfig[TName]}
 */
/**
 * @template {keyof GeneratedEnvVarConfig} TName
 * @overload
 * @param {TName} name Environment variable name
 * @param {boolean} skipDefault Return `undefined` instead of the registered default when unset.
 * @returns {GeneratedEnvVarConfig[TName] | undefined}
 */
/**
 * @overload
 * @param {string} name Environment variable name
 * @param {boolean} [skipDefault] Return `undefined` instead of the registered default when unset.
 * @returns {string | number | boolean | object | undefined}
 */
/**
 * @param {string} name
 * @param {boolean} [skipDefault]
 * @throws {Error} if the configuration is not supported
 */
function getValueFromEnvSources (name, skipDefault) {
  validateAccess(name)

  if (!stableConfigLoaded) {
    loadStableConfig()
  }

  // Sources are read in priority order (fleet > env > local). A value the parser
  // or transformer rejects resolves to `undefined` and is ignored, falling
  // through to the next source and finally the registered default — mirroring
  // how Config applies env sources (`setAndTrack` skips such values). This keeps
  // a malformed higher-priority value (e.g. a fleet-stable `DD_TRACE_DEBUG=maybe`)
  // from masking a valid `DD_TRACE_DEBUG=true`.
  if (fleetStableConfig !== undefined) {
    const fromFleet = getValueFromSource(name, fleetStableConfig)
    if (fromFleet !== undefined) {
      const parsed = parseConfigurationValue(name, fromFleet, 'fleet_stable_config')
      if (parsed !== undefined) {
        return parsed
      }
    }
  }

  const fromEnv = getValueFromSource(name, process.env)
  if (fromEnv !== undefined) {
    const parsed = parseConfigurationValue(name, fromEnv, 'env_var')
    if (parsed !== undefined) {
      return parsed
    }
  }

  if (localStableConfig !== undefined) {
    const fromLocal = getValueFromSource(name, localStableConfig)
    if (fromLocal !== undefined) {
      const parsed = parseConfigurationValue(name, fromLocal, 'local_stable_config')
      if (parsed !== undefined) {
        return parsed
      }
    }
  }

  return skipDefault ? undefined : getRegisteredDefault(name)
}

module.exports = {
  getValueFromEnvSources,

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
  getEnvironmentVariables (source = process.env, internalOnly = false) {
    const configs = {}
    for (const [key, value] of Object.entries(source)) {
      if (key.startsWith('DD_') || key.startsWith('OTEL_') || aliasToCanonical[key]) {
        if (supportedConfigurations[key]) {
          configs[key] = value
        } else if (aliasToCanonical[key] && configs[aliasToCanonical[key]] === undefined) {
          // The alias should only be used if the actual configuration is not set
          // In case that more than a single alias exist, use the one defined first in our own order
          for (const alias of aliases[aliasToCanonical[key]]) {
            if (source[alias] !== undefined) {
              configs[aliasToCanonical[key]] = value
              break
            }
          }
        // TODO(BridgeAR) Implement logging. It would have to use a timeout to
        // lazily log the message after all loading being done otherwise.
        //   debug(
        //     `Missing configuration ${env} in supported-configurations file. The environment variable is ignored.`
        //   )
        // This could be moved inside the main config logic.
        }
        deprecationMethods[key]?.()
      } else if (!internalOnly) {
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
   * Returns the actual environment variable name used for a supported configuration
   * from a specific environment-based source.
   *
   * @param {string} name Environment variable name
   * @returns {string|undefined}
   */
  getConfiguredEnvName (name) {
    validateAccess(name)

    if (!stableConfigLoaded) {
      loadStableConfig()
    }

    for (const source of [fleetStableConfig, process.env, localStableConfig]) {
      if (source !== undefined) {
        const fromSource = getEnvNameFromSource(name, source)
        if (fromSource !== undefined) {
          return fromSource
        }
      }
    }
  },
}
