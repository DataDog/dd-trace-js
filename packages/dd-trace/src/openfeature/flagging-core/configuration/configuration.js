'use strict'

/**
 * Internal flags configuration for DatadogProvider.
 * @typedef {Object} FlagsConfiguration
 * @property {PrecomputedConfiguration} [precomputed]
 */

/**
 * @typedef {Object} PrecomputedConfiguration
 * @property {PrecomputedConfigurationResponse} response
 * @property {Object} [context] - EvaluationContext
 * @property {number} [fetchedAt] - UnixTimestamp
 */

/**
 * Fancy way to map FlagValueType to expected FlagValue.
 * @typedef {boolean|string|number|Object} FlagTypeToValue
 */

/**
 * Timestamp in milliseconds since Unix Epoch.
 * @typedef {number} UnixTimestamp
 */

/**
 * @typedef {Object} PrecomputedConfigurationResponse
 * @property {Object} data
 * @property {Object} data.attributes
 * @property {string} data.attributes.createdAt - When configuration was generated
 * @property {Object.<string, PrecomputedFlag>} data.attributes.flags
 */

/**
 * @typedef {Object} PrecomputedFlag
 * @property {string} allocationKey
 * @property {string} variationKey
 * @property {string} variationType
 * @property {*} variationValue
 * @property {string} reason
 * @property {boolean} doLog
 * @property {Object.<string, *>} extraLogging
 */

/**
 * @typedef {Object} PrecomputedFlagMetadata
 * @property {string} allocationKey
 * @property {string} variationType
 * @property {boolean} doLog
 */

// No exports needed - these are just JSDoc type definitions
module.exports = {}