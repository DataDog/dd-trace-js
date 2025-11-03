'use strict'

/**
 * @typedef {'BOOLEAN'|'INTEGER'|'NUMERIC'|'STRING'|'JSON'} VariantType
 */

/**
 * @typedef {Object} VariantConfiguration
 * @property {string} key
 * @property {*} value - FlagValue
 */

/**
 * @typedef {Object} ShardRange
 * @property {number} start
 * @property {number} end
 */

/**
 * @typedef {Object} Shard
 * @property {string} salt
 * @property {ShardRange[]} ranges
 * @property {number} totalShards
 */

/**
 * @typedef {Object} Split
 * @property {string} variationKey
 * @property {Shard[]} shards
 * @property {Object.<string, string>} [extraLogging]
 */

/**
 * @typedef {Object} Allocation
 * @property {string} key
 * @property {Object[]} [rules] - Rule[]
 * @property {Date} [startAt]
 * @property {Date} [endAt]
 * @property {Split[]} splits
 * @property {boolean} [doLog]
 */

/**
 * @typedef {Object} Flag
 * @property {string} key
 * @property {boolean} enabled
 * @property {VariantType} variationType
 * @property {Object.<string, VariantConfiguration>} variations
 * @property {Allocation[]} allocations
 */

/**
 * @typedef {Object} UniversalFlagConfigurationV1
 * @property {string} createdAt
 * @property {string} format
 * @property {Object} environment
 * @property {string} environment.name
 * @property {Object.<string, Flag>} flags
 */

/**
 * @typedef {Object} UniversalFlagConfigurationV1Response
 * @property {Object} data
 * @property {string} data.type
 * @property {string} data.id
 * @property {UniversalFlagConfigurationV1} data.attributes
 */

function variantTypeToFlagValueType(variantType) {
  if (variantType === 'BOOLEAN') {
    return 'boolean'
  }
  if (variantType === 'STRING') {
    return 'string'
  }
  if (variantType === 'INTEGER' || variantType === 'NUMERIC') {
    return 'number'
  }
  if (variantType === 'JSON') {
    return 'object'
  }
  throw new Error(`Cannot convert variant type to flag value type: ${variantType}`)
}

module.exports = {
  variantTypeToFlagValueType
}