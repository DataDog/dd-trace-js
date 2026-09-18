'use strict'

/**
 * Text form of an evaluator input. Strings pass through, other primitives use
 * `String()`, and objects/arrays are JSON-encoded (Python uses `str()`, whose
 * dict/list repr has no JavaScript equivalent).
 * @param {unknown} value
 * @returns {string}
 */
function toText (value) {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') {
    try {
      const encoded = JSON.stringify(value)
      if (encoded !== undefined) return encoded
    } catch {}
  }
  return String(value)
}

/**
 * @param {unknown} value
 * @returns {value is Promise<unknown>}
 */
function isThenable (value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function'
}

module.exports = { isThenable, toText }
