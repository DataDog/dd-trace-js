'use strict'

/**
 * @typedef {import('./helper').SupportedConfigurationsJson['supportedConfigurations']} SupportedConfigurations
 */

/**
 * Collapses each configuration's per-major entries to the single entry that applies to
 * `majorVersion`. An entry's optional `major` selector is either an exact major ("5") or a
 * lower-bounded range (">5"); an entry without a selector applies to every major. A configuration
 * left without any matching entry is dropped for this major.
 *
 * @param {SupportedConfigurations} supportedConfigurations Mutated in place.
 * @param {number} majorVersion
 */
function applyMajorOverrides (supportedConfigurations, majorVersion) {
  for (const [canonicalName, entries] of Object.entries(supportedConfigurations)) {
    const selected = entries.filter((entry) => entry.major === undefined || majorMatches(entry.major, majorVersion))
    if (selected.length === 0) {
      delete supportedConfigurations[canonicalName]
      continue
    }
    for (const entry of selected) {
      delete entry.major
    }
    if (selected.length !== entries.length) {
      supportedConfigurations[canonicalName] = selected
    }
  }
}

/**
 * @param {string} selector Exact major ("5") or a lower-bounded range (">5").
 * @param {number} majorVersion
 */
function majorMatches (selector, majorVersion) {
  if (selector[0] === '>') {
    return majorVersion > Number(selector.slice(1))
  }
  return majorVersion === Number(selector)
}

module.exports = applyMajorOverrides
