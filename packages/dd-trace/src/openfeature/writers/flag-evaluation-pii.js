'use strict'

const { hashTargetingKey: digestTargetingKey } = require('../encoding')

// Keep this vocabulary explicit: an upstream enum addition needs a privacy review.
const ERROR_CODES = new Set([
  'PROVIDER_NOT_READY',
  'PROVIDER_FATAL',
  'FLAG_NOT_FOUND',
  'PARSE_ERROR',
  'TYPE_MISMATCH',
  'TARGETING_KEY_MISSING',
  'INVALID_CONTEXT',
  'GENERAL',
])

/**
 * Validate targeting text before UTF-8 encoding, which would repair lone surrogates.
 * Empty text is valid and distinct from a missing key. Do not coerce customer input.
 *
 * @param {unknown} value - Evaluation targeting key
 * @returns {string | undefined}
 */
function normalizeTargetingKey (value) {
  if (typeof value !== 'string') return

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code >= 0xD8_00 && code <= 0xDB_FF) {
      if (++i === value.length) return
      const low = value.charCodeAt(i)
      if (low < 0xDC_00 || low > 0xDF_FF) return
    } else if (code >= 0xDC_00 && code <= 0xDF_FF) {
      return
    }
  }

  return value
}

/**
 * Apply EVP's protected targeting-key policy using the shared SHA-256 primitive.
 * This runs after queue handoff; hashing must not move onto the evaluation hot path.
 *
 * @param {unknown} value - Raw evaluation targeting key, never a previously emitted hash
 * @returns {string | undefined}
 */
function prefixedTargetingKeyDigest (value) {
  const key = normalizeTargetingKey(value)
  if (key === undefined || key === '') return key
  return 'sha256_' + digestTargetingKey(key)
}

/**
 * Preserve only approved OpenFeature codes on the wire, in every consent mode.
 * Absence means no error; malformed or unknown supplied codes become GENERAL.
 *
 * @param {unknown} value - OpenFeature errorCode, never errorMessage
 * @returns {string | undefined}
 */
function protectedErrorCode (value) {
  if (value === undefined || value === null || value === '') return
  return typeof value === 'string' && ERROR_CODES.has(value) ? value : 'GENERAL'
}

module.exports = {
  normalizeTargetingKey,
  prefixedTargetingKeyDigest,
  protectedErrorCode,
}
