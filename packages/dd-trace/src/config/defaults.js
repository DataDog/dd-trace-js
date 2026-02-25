'use strict'

const pkg = require('../pkg')
const { isFalse, isTrue } = require('../util')
const { getEnvironmentVariable: getEnv } = require('./helper')

const {
  supportedConfigurations,
} = /** @type {import('./helper').SupportedConfigurationsJson} */ (require('./supported-configurations.json'))

const service = getEnv('AWS_LAMBDA_FUNCTION_NAME') ||
  getEnv('FUNCTION_NAME') || // Google Cloud Function Name set by deprecated runtimes
  getEnv('K_SERVICE') || // Google Cloud Function Name set by newer runtimes
  getEnv('WEBSITE_SITE_NAME') || // set by Azure Functions
  pkg.name ||
  'node'

/**
 * @param {string|null} raw
 * @param {string} type
 * @returns {string|number|boolean|Record<string, string>|unknown[]|undefined}
 */
function parseDefaultByType (raw, type) {
  if (raw === null) {
    return
  }

  switch (type) {
    case 'boolean':
      if (isTrue(raw)) return true
      if (isFalse(raw)) return false
      // TODO: What should we do with these?
      return
    case 'int':
    case 'decimal': {
      return Number(raw)
    }
    case 'array': {
      if (raw.length === 0) return []
      // TODO: Make the parsing a helper that is reused.
      return raw.split(',').map(item => {
        const colonIndex = item.indexOf(':')
        if (colonIndex === -1) {
          return item.trim()
        }
        const key = item.slice(0, colonIndex).trim()
        const value = item.slice(colonIndex + 1).trim()
        return `${key}:${value}`
      })
    }
    case 'map': {
      if (raw.length === 0) return {}
      // TODO: Make the parsing a helper that is reused.
      /** @type {Record<string, string>} */
      const entries = {}
      for (const item of raw.split(',')) {
        const colonIndex = item.indexOf(':')
        if (colonIndex === -1) {
          const key = item.trim()
          if (key.length > 0) {
            entries[key] = ''
          }
          continue
        }
        const key = item.slice(0, colonIndex).trim()
        const value = item.slice(colonIndex + 1).trim()
        if (key.length > 0) {
          entries[key] = value
        }
      }
      return entries
    }
    default:
      return raw
  }
}

/** @type {Record<string, unknown>} */
const metadataDefaults = {}
for (const entries of Object.values(supportedConfigurations)) {
  for (const entry of entries) {
    // TODO: Replace $dynamic with method names that would be called and that
    // are also called when the user passes through the value. That way the
    // handling is unified and methods can be declared as default.
    // The name of that method should be expressive for users.
    // TODO: Add handling for all environment variable names. They should not
    // need a configuration name for being listed with their default.
    if (!Array.isArray(entry.configurationNames)) {
      continue
    }

    const parsedValue = parseDefaultByType(entry.default, entry.type)
    for (const configurationName of entry.configurationNames) {
      metadataDefaults[configurationName] = entry.default === null ? undefined : parsedValue
    }
  }
}

// Defaults required by JS config merge/applyCalculated that are not represented in supported-configurations.
const defaultsWithoutSupportedConfigurationEntry = {
  'cloudPayloadTagging.rules': [],
  'cloudPayloadTagging.requestsEnabled': false,
  'cloudPayloadTagging.responsesEnabled': false,
  isAzureFunction: false,
  isCiVisibility: false,
  isGCPFunction: false,
  instrumentationSource: 'manual',
  isServiceUserProvided: false,
  lookup: undefined,
  plugins: true,
}

// These values are documented in supported-configurations as CI Visibility
// defaults. Keep startup baseline false and let #applyCalculated() switch them
// when CI Visibility is active.
// TODO: These entries should be removed. They are off by default
// because they rely on other configs.
const defaultsWithConditionalRuntimeBehavior = {
  isGitUploadEnabled: false,
  isImpactedTestsEnabled: false,
  isIntelligentTestRunnerEnabled: false,
  isManualApiEnabled: false,
  isTestManagementEnabled: false,
  // TODO: These are not conditional, they would just be of type number.
  'dogstatsd.port': '8125',
  port: '8126',
  // Override due to expecting numbers, not strings. TODO: Replace later.
  'grpc.client.error.statuses': [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],
  'grpc.server.error.statuses': [2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],
}

/** @type {Record<string, unknown>} */
const defaults = {
  ...defaultsWithoutSupportedConfigurationEntry,
  ...metadataDefaults,
  ...defaultsWithConditionalRuntimeBehavior,
  service,
  version: pkg.version,
}

module.exports = defaults
