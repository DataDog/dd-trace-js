'use strict'

const crypto = require('crypto')

/**
 * Encode a single value as a varint (variable-length integer).
 * Uses 7 bits per byte, with MSB as continuation flag.
 *
 * @param {number} value - Non-negative integer to encode
 * @returns {number[]} Array of bytes representing the varint
 */
function encodeVarint (value) {
  const bytes = []
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80) // Set continuation bit
    value >>>= 7
  }
  bytes.push(value & 0x7f) // Final byte without continuation bit
  return bytes
}

/**
 * Encode an array of serial IDs using delta-varint encoding.
 *
 * Algorithm:
 * 1. Sort serial IDs in ascending order
 * 2. Compute deltas from previous value (first delta = first value)
 * 3. Encode each delta as varint
 * 4. Base64 encode the result
 *
 * @param {number[]} serialIds - Array of serial IDs to encode
 * @returns {string} Base64-encoded delta-varint string
 */
function encodeDeltaVarint (serialIds) {
  if (!serialIds || serialIds.length === 0) {
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

module.exports = {
  encodeVarint,
  encodeDeltaVarint,
  hashTargetingKey
}
