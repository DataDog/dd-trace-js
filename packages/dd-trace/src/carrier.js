'use strict'

// RFC 7230 §3.2.2 resolves a repeated field per field name: list-valued fields
// combine with commas, singleton fields take the last value.
// https://www.rfc-editor.org/rfc/rfc7230#section-3.2.2

/** @typedef {Record<string, unknown>} Carrier */

/**
 * Skipping non-strings keeps a Symbol or a throwing `toString` from aborting
 * extraction, which discards the whole context rather than one field.
 *
 * @param {unknown[]} values
 */
function joinStrings (values) {
  let joined = ''
  let first = true

  for (const value of values) {
    if (typeof value !== 'string') continue
    if (first) {
      joined = value
      first = false
    } else {
      joined += `,${value}`
    }
  }

  return joined
}

/** @param {unknown[]} values */
function lastString (values) {
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i]
    if (typeof value === 'string') return value
  }
}

/**
 * @param {Carrier} carrier
 * @param {string} key
 * @returns {string | undefined}
 */
function readList (carrier, key) {
  const value = carrier[key]
  if (typeof value === 'string') return value
  return Array.isArray(value) ? joinStrings(value) : undefined
}

/**
 * @param {Carrier} carrier
 * @param {string} key
 */
function readSingleton (carrier, key) {
  const value = carrier[key]
  // Unlike `readList`, a non-string passes through: the DSM v1 pathway decoder
  // reads a Buffer.
  return Array.isArray(value) ? lastString(value) : value
}

module.exports = {
  readList,
  readSingleton,
}
