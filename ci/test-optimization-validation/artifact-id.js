'use strict'

const crypto = require('node:crypto')

const MAX_PREFIX_LENGTH = 72

/**
 * Maps an arbitrary manifest identifier to a bounded, portable, collision-resistant path segment.
 *
 * @param {string} source original identifier
 */
function getArtifactId (source) {
  const prefix = source.replaceAll(/[^a-zA-Z0-9._-]+/g, '-').slice(0, MAX_PREFIX_LENGTH) || 'framework'
  const digest = crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)
  return `${prefix}-${digest}`
}

module.exports = { getArtifactId }
