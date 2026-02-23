'use strict'

const pkg = require('../pkg')
const { getEnvironmentVariable: getEnv } = require('./helper')
const { isFalse, isTrue } = require('../util')

const {
  supportedConfigurations
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
  if (raw === null || raw === '$dynamic') {
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
      return JSON.parse(raw)
    }
    case 'map': {
      if (raw.length === 0) return {}
      return JSON.parse(raw)
    }
    default:
      return raw
  }
}

/** @type {Record<string, unknown>} */
const metadataDefaults = {}
for (const entries of Object.values(supportedConfigurations)) {
  for (const entry of entries) {
    if (
      entry.implementation !== 'A' ||
      entry.default === '$dynamic' ||
      !('configurationNames' in entry) ||
      !Array.isArray(entry.configurationNames)
    ) {
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
}

/** @type {Record<string, unknown>} */
const defaults = {
  ...defaultsWithoutSupportedConfigurationEntry,
  ...metadataDefaults,
  ...defaultsWithConditionalRuntimeBehavior,
}

defaults.service = service
defaults.version = pkg.version

module.exports = defaults
