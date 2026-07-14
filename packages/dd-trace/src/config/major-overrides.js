'use strict'

/**
 * @typedef {import('./helper').SupportedConfigurationsJson['supportedConfigurations']} SupportedConfigurations
 */

const EXPERIMENTAL_APPSEC_PREFIX = 'experimental.appsec'
const EXPERIMENTAL_IAST_PREFIX = 'experimental.iast'
const INGESTION_PREFIX = 'ingestion.'

/**
 * @param {SupportedConfigurations} supportedConfigurations Mutated in place.
 * @param {number} majorVersion
 */
function applyMajorOverrides (supportedConfigurations, majorVersion) {
  if (majorVersion < 6) {
    applyV5Overrides(supportedConfigurations)
    return
  }

  for (const entries of Object.values(supportedConfigurations)) {
    for (const entry of entries) {
      if (Array.isArray(entry.configurationNames)) {
        entry.configurationNames = entry.configurationNames.filter(
          (name) =>
            name !== EXPERIMENTAL_APPSEC_PREFIX &&
            name !== EXPERIMENTAL_IAST_PREFIX &&
            !name.startsWith(`${EXPERIMENTAL_APPSEC_PREFIX}.`) &&
            !name.startsWith(`${EXPERIMENTAL_IAST_PREFIX}.`) &&
            !name.startsWith(INGESTION_PREFIX)
        )
        if (entry.configurationNames.length === 0) delete entry.configurationNames
      }
    }
  }
  delete supportedConfigurations.DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED
  delete supportedConfigurations.DD_TRACE_EXPERIMENTAL_B3_ENABLED

  /* eslint-disable eslint-rules/eslint-env-aliases */
  for (const name of [
    'DD_PROFILING_EXPERIMENTAL_CODEHOTSPOTS_ENABLED',
    'DD_PROFILING_EXPERIMENTAL_CPU_ENABLED',
    'DD_PROFILING_EXPERIMENTAL_ENDPOINT_COLLECTION_ENABLED',
    'DD_PROFILING_EXPERIMENTAL_TIMELINE_ENABLED',
  ]) {
    delete supportedConfigurations[name]
  }
  /* eslint-enable eslint-rules/eslint-env-aliases */
  for (const canonical of [
    'DD_PROFILING_CODEHOTSPOTS_ENABLED',
    'DD_PROFILING_CPU_ENABLED',
    'DD_PROFILING_ENDPOINT_COLLECTION_ENABLED',
    'DD_PROFILING_TIMELINE_ENABLED',
  ]) {
    dropAlias(supportedConfigurations[canonical], (alias) => alias.startsWith('DD_PROFILING_EXPERIMENTAL_'))
  }

  delete supportedConfigurations.DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED
  // eslint-disable-next-line eslint-rules/eslint-env-aliases
  dropAlias(supportedConfigurations.DD_RUNTIME_METRICS_RUNTIME_ID_ENABLED, 'DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED')

  if (majorVersion >= 7) {
    // The Electron plugin moved to the Electron SDK and is opt-in (disabled by default) from v7 on,
    // while remaining enabled by default on earlier majors (see ElectronPlugin.experimental).
    const electronEntry = supportedConfigurations.DD_TRACE_ELECTRON_ENABLED?.[0]
    if (electronEntry) electronEntry.default = 'false'
  }
}

/**
 * @param {SupportedConfigurations} supportedConfigurations Mutated in place.
 */
function applyV5Overrides (supportedConfigurations) {
  const startupLogsEntry = supportedConfigurations.DD_TRACE_STARTUP_LOGS?.[0]
  if (startupLogsEntry) {
    startupLogsEntry.default = 'false'
  }

  const iastEntry = supportedConfigurations.DD_IAST_SECURITY_CONTROLS_CONFIGURATION?.[0]
  if (!iastEntry) return

  // v5 kept this configurable through the (experimental) iast.* programmatic API. The entry
  // still carries `namespace: "iast"`, so these names route to iast.DD_IAST_SECURITY_CONTROLS_CONFIGURATION
  // and the property path stays canonical across majors.
  iastEntry.configurationNames = [
    'iast.securityControlsConfiguration',
    `${EXPERIMENTAL_IAST_PREFIX}.securityControlsConfiguration`,
  ]
}

/**
 * @param {import('./helper').SupportedConfigurationEntry[] | undefined} entries
 * @param {string | ((alias: string) => boolean)} dropPredicate
 */
function dropAlias (entries, dropPredicate) {
  const entry = entries?.[0]
  if (entry?.aliases === undefined) return
  const matches = typeof dropPredicate === 'string'
    ? (alias) => alias === dropPredicate
    : dropPredicate
  entry.aliases = entry.aliases.filter((alias) => !matches(alias))
  if (entry.aliases.length === 0) {
    delete entry.aliases
  }
}

module.exports = applyMajorOverrides
