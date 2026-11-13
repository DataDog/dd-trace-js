'use strict'

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
    if (Number.isInteger(value)) {
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

module.exports = { transformAnyValue, transformAttributes }
