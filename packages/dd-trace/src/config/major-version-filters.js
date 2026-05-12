'use strict'

/**
 * @typedef {import('./helper').SupportedConfigurationsJson['supportedConfigurations']} SupportedConfigurations
 */

const EXPERIMENTAL_IAST_PREFIX = 'experimental.iast'

const filtered = new WeakSet()

/**
 * Shared between `helper.js` / `defaults.js` (runtime) and `eslint-config-names-sync` (lint) so
 * the JSON ↔ `index.d.ts` sync check uses the same view as the runtime parser. Idempotent on a
 * per-object basis so callers don't have to coordinate load order.
 *
 * @param {SupportedConfigurations} supportedConfigurations Mutated in place.
 * @param {number} majorVersion
 */
function applyMajorVersionAliasFilters (supportedConfigurations, majorVersion) {
  if (filtered.has(supportedConfigurations)) return
  filtered.add(supportedConfigurations)

  if (majorVersion < 6) return

  // v6 strips both the bare `experimental.iast` alias and its nested forms so
  // `#applyOptions` warns "Unknown option" instead of writing user-supplied
  // objects into `iast.enabled` via the bare alias.
  for (const entries of Object.values(supportedConfigurations)) {
    for (const entry of entries) {
      if (Array.isArray(entry.configurationNames)) {
        entry.configurationNames = entry.configurationNames.filter(
          (name) => name !== EXPERIMENTAL_IAST_PREFIX && !name.startsWith(`${EXPERIMENTAL_IAST_PREFIX}.`)
        )
      }
    }
  }

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
}

/**
 * Filter aliases on a canonical entry in-place. `dropPredicate` may be a string (exact match) or
 * a function called per alias. No-op when the canonical is missing so this stays usable against
 * the eslint sync test fixtures.
 *
 * @param {SupportedConfigurations[string] | undefined} entries
 * @param {string | ((alias: string) => boolean)} dropPredicate
 */
function dropAlias (entries, dropPredicate) {
  const entry = entries?.[0]
  if (entry?.aliases === undefined) return
  const matches = typeof dropPredicate === 'string'
    ? (alias) => alias === dropPredicate
    : dropPredicate
  entry.aliases = entry.aliases.filter((alias) => !matches(alias))
  if (entry.aliases.length === 0) delete entry.aliases
}

module.exports = { applyMajorVersionAliasFilters }
