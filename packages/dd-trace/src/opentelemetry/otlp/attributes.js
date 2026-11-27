'use strict'

// OTLP integer fields are signed 64-bit. Larger integers wrap in protobuf and are rejected in JSON,
// so they are exported as doubles instead.
const INT64_MIN = -(2 ** 63)
const INT64_MAX_EXCLUSIVE = 2 ** 63

/**
 * Whether a number can be exported as an OTLP int64 (or sfixed64) value.
 *
 * @param {number} value
 */
function isInt64 (value) {
  return Number.isInteger(value) && value >= INT64_MIN && value < INT64_MAX_EXCLUSIVE
}

/**
 * Converts a value to an OTLP AnyValue. Unexpected types become strings.
 *
 * @param {unknown} value
 * @returns {object}
 */
function transformAnyValue (value) {
  if (typeof value === 'string') {
    return { stringValue: value }
  } else if (typeof value === 'number') {
    if (isInt64(value)) {
      return { intValue: value }
    }
    return { doubleValue: value }
  } else if (typeof value === 'boolean') {
    return { boolValue: value }
  } else if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map(v => transformAnyValue(v)),
      },
    }
  }
  // Fallback for any unexpected types
  return { stringValue: String(value) }
}

/**
 * Converts attributes to OTLP KeyValues, as all OTLP signals encode them.
 *
 * @param {Record<string, unknown>} attributes
 * @returns {Array<{ key: string, value: object }>}
 */
function transformAttributes (attributes) {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: transformAnyValue(value),
  }))
}

module.exports = { isInt64, transformAnyValue, transformAttributes }
