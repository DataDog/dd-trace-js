'use strict'

/**
 * @typedef {Object} ConfigurationWire
 * @property {number} version
 * @property {Object} [precomputed]
 * @property {Object} [precomputed.context] - EvaluationContext
 * @property {string} precomputed.response
 * @property {number} [precomputed.fetchedAt] - UnixTimestamp
 */

/**
 * Create configuration from a string created with `configurationToString`.
 * @param {string} s
 * @returns {Object} FlagsConfiguration
 */
function configurationFromString(s) {
  try {
    const wire = JSON.parse(s)

    if (wire.version !== 1) {
      // Unknown version
      return {}
    }

    const configuration = {}
    if (wire.precomputed) {
      configuration.precomputed = {
        ...wire.precomputed,
        response: JSON.parse(wire.precomputed.response),
      }
    }

    return configuration
  } catch {
    return {}
  }
}

/**
 * Serialize configuration to string that can be deserialized with
 * `configurationFromString`. The serialized string format is
 * unspecified.
 * @param {Object} configuration - FlagsConfiguration
 * @returns {string}
 */
function configurationToString(configuration) {
  const wire = {
    version: 1,
  }

  if (configuration.precomputed) {
    wire.precomputed = {
      ...configuration.precomputed,
      response: JSON.stringify(configuration.precomputed),
    }
  }

  return JSON.stringify(wire)
}

module.exports = {
  configurationFromString,
  configurationToString
}