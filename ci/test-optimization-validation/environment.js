'use strict'

/**
 * Compares environment variable names using the child platform's semantics.
 *
 * @param {string} left first variable name
 * @param {string} right second variable name
 * @param {string} [platform] target platform
 * @returns {boolean} whether the names are equivalent
 */
function environmentNamesEqual (left, right, platform = process.platform) {
  return platform === 'win32' ? left.toUpperCase() === right.toUpperCase() : left === right
}

/**
 * Finds an environment entry without inventing a second spelling on Windows.
 *
 * @param {Record<string, string|undefined>} environment environment object
 * @param {string} name variable name
 * @param {string} [platform] target platform
 * @returns {[string, string|undefined]|undefined} matching entry
 */
function findEnvironmentEntry (environment, name, platform = process.platform) {
  return Object.entries(environment || {}).find(([candidate]) => {
    return environmentNamesEqual(candidate, name, platform)
  })
}

/**
 * Reads an environment value using platform name semantics.
 *
 * @param {Record<string, string|undefined>} environment environment object
 * @param {string} name variable name
 * @param {string} [platform] target platform
 * @returns {string|undefined} environment value
 */
function getEnvironmentValue (environment, name, platform = process.platform) {
  return findEnvironmentEntry(environment, name, platform)?.[1]
}

/**
 * Replaces every equivalent spelling with one canonical entry.
 *
 * @param {Record<string, string|undefined>} environment environment object
 * @param {string} name canonical variable name
 * @param {string|undefined} value environment value
 * @param {string} [platform] target platform
 * @returns {void}
 */
function setEnvironmentValue (environment, name, value, platform = process.platform) {
  for (const candidate of Object.keys(environment)) {
    if (environmentNamesEqual(candidate, name, platform)) delete environment[candidate]
  }
  environment[name] = value
}

/**
 * Applies environment entries with Windows-compatible replacement semantics.
 *
 * @param {Record<string, string|undefined>} target destination environment
 * @param {Record<string, string|undefined>} source overriding entries
 * @param {string} [platform] target platform
 * @returns {void}
 */
function mergeEnvironment (target, source, platform = process.platform) {
  if (source) {
    for (const [name, value] of Object.entries(source)) {
      setEnvironmentValue(target, name, value, platform)
    }
  }
}

/**
 * Reports whether a name belongs to the private or public Datadog environment namespace.
 *
 * @param {string} name variable name
 * @param {string} [platform] target platform
 * @returns {boolean} whether this is a Datadog variable
 */
function isDatadogEnvironmentName (name, platform = process.platform) {
  const normalized = platform === 'win32' ? name.toUpperCase() : name
  return normalized.startsWith('DD_') || normalized.startsWith('_DD_')
}

module.exports = {
  environmentNamesEqual,
  findEnvironmentEntry,
  getEnvironmentValue,
  isDatadogEnvironmentName,
  mergeEnvironment,
  setEnvironmentValue,
}
