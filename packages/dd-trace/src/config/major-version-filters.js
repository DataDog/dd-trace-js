'use strict'

/**
 * @typedef {import('./helper').SupportedConfigurationsJson['supportedConfigurations']} SupportedConfigurations
 */

const EXPERIMENTAL_IAST_PREFIX = 'experimental.iast'

/**
 * Shared between `defaults.js` (runtime) and `eslint-config-names-sync` (lint) so
 * the JSON ↔ `index.d.ts` sync check uses the same view as the runtime parser.
 *
 * @param {SupportedConfigurations} supportedConfigurations Mutated in place.
 * @param {number} majorVersion
 */
function applyMajorVersionAliasFilters (supportedConfigurations, majorVersion) {
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
}

module.exports = { applyMajorVersionAliasFilters }
