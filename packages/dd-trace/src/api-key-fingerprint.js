'use strict'

const { createHash } = require('node:crypto')

const BASE62_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const BASE62_RADIX = 62n
const SHA256_BASE62_LENGTH = 43

/**
 * Creates the canonical stable identifier for a Datadog API key.
 *
 * @param {string} apiKey - Datadog API key
 * @returns {string} Prefixed, fixed-width SHA-256 fingerprint
 */
function createAPIKeyFingerprint (apiKey) {
  const digest = createHash('sha256').update(apiKey).digest()
  let value = BigInt(`0x${digest.toString('hex')}`)
  let encoded = ''

  do {
    encoded = BASE62_ALPHABET[Number(value % BASE62_RADIX)] + encoded
    value /= BASE62_RADIX
  } while (value > 0n)

  return `rijn_${encoded.padStart(SHA256_BASE62_LENGTH, '0')}`
}

module.exports = { createAPIKeyFingerprint }
