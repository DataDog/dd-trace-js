const crypto = require('crypto')

const S3_PTR_KIND = 'aws.s3.object'

const SPAN_POINTER_DIRECTION = Object.freeze({
  UPSTREAM: 'u',
  DOWNSTREAM: 'd'
})

/**
 * Generates a unique hash from an array of strings by joining them with | before hashing.
 * Used to uniquely identify AWS requests for span pointers.
 * Expects S3 ETag to already have quotes removed!
 * @param {string[]} components - Array of strings to hash
 * @returns {string} A 32-character hash uniquely identifying the components
 */
function generatePointerHash (components) {
  const dataToHash = components.join('|')
  const hash = crypto.createHash('sha256').update(dataToHash).digest('hex')
  return hash.substring(0, 32)
}

module.exports = {
  S3_PTR_KIND,
  SPAN_POINTER_DIRECTION,
  generatePointerHash
}
