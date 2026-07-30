'use strict'

const crypto = require('node:crypto')

const BASE62_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const CLIFFORD_SHA256_BASE62_LENGTH = 43

/**
 * Encode a single value as a ULEB128 varint (variable-length integer).
 * Uses 7 bits per byte, with MSB as continuation flag.
 *
 * @param {number} value - Non-negative integer to encode
 * @returns {number[]} Array of bytes representing the varint
 */
function encodeVarint (value) {
  const bytes = []
  while (value > 0x7F) {
    bytes.push((value & 0x7F) | 0x80) // Set continuation bit
    value >>>= 7
  }
  bytes.push(value & 0x7F) // Final byte without continuation bit
  return bytes
}

/**
 * Encode a set of serial IDs using delta-varint encoding.
 *
 * Algorithm:
 * 1. Sort serial IDs in ascending order
 * 2. Compute deltas from previous value (first delta = first value)
 * 3. Encode each delta as varint
 * 4. Base64 encode the result
 *
 * @param {Set<number>} serialIds - Set of serial IDs to encode
 * @returns {string} Base64-encoded delta-varint string
 */
function encodeDeltaVarint (serialIds) {
  if (!serialIds || serialIds.size === 0) {
    return ''
  }

  // Sort IDs in ascending order
  const sorted = [...serialIds].sort((a, b) => a - b)

  // Compute deltas and encode as varints
  const bytes = []
  let prev = 0

  for (const id of sorted) {
    const delta = id - prev
    bytes.push(...encodeVarint(delta))
    prev = id
  }

  // Base64 encode the byte array
  return Buffer.from(bytes).toString('base64')
}

/**
 * Hash a targeting key using SHA256.
 *
 * @param {string} targetingKey - The targeting key to hash
 * @returns {string} Lowercase hex digest of the SHA256 hash
 */
function hashTargetingKey (targetingKey) {
  return crypto.createHash('sha256').update(targetingKey).digest('hex')
}

/**
 * Generate a Clifford v1 fingerprint from an API key.
 *
 * @param {string} apiKey - The API key to fingerprint
 * @returns {string} The rijn-prefixed, base62-encoded SHA256 fingerprint
 */
function generateApiKeyFingerprint (apiKey) {
  const digest = crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex')
  let value = BigInt(`0x${digest}`)
  let encoded = ''

  while (value > 0n) {
    encoded = BASE62_ALPHABET[Number(value % 62n)] + encoded
    value /= 62n
  }

  return `rijn_${encoded.padStart(CLIFFORD_SHA256_BASE62_LENGTH, '0')}`
}

module.exports = {
  encodeVarint,
  encodeDeltaVarint,
  generateApiKeyFingerprint,
  hashTargetingKey,
}
