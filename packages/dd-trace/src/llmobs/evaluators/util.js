'use strict'

const { EvaluatorResult } = require('../experiments/evaluator')

/**
 * Text form of an evaluator input. Strings pass through, other primitives use
 * `String()`, and objects/arrays are JSON-encoded (Python uses `str()`, whose
 * dict/list repr has no JavaScript equivalent).
 * @param {unknown} value
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
  if (value === null || typeof value !== 'object') return false
  return typeof (/** @type {{ then?: unknown }} */ (value)).then === 'function'
}

/**
 * @param {unknown} fn
 * @param {string} name
 */
function assertOptionalFunction (fn, name) {
  if (fn !== undefined && fn !== null && typeof fn !== 'function') {
    throw new TypeError(`${name} must be a callable function`)
  }
}

/**
 * @param {boolean} passed
 * @returns {EvaluatorResult}
 */
function booleanResult (passed) {
  return new EvaluatorResult(passed, { assessment: passed ? 'pass' : 'fail' })
}

module.exports = { assertOptionalFunction, booleanResult, isThenable, toText }
