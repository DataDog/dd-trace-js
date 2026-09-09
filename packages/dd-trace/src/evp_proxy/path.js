'use strict'

const LEADING_SLASHES = /^\/+/
const TRAILING_SLASHES = /\/+$/

/**
 * Joins a caller-supplied EVP proxy path and product endpoint.
 *
 * This utility does not perform EVP proxy discovery.
 *
 * @param {string} basePath - EVP proxy base path
 * @param {string} endpoint - Product intake endpoint
 * @returns {string} Joined request path
 */
function joinEVPProxyPath (basePath, endpoint) {
  const normalizedBasePath = basePath.replace(TRAILING_SLASHES, '')
  const normalizedEndpoint = endpoint.replace(LEADING_SLASHES, '')

  return `${normalizedBasePath}/${normalizedEndpoint}`
}

module.exports = { joinEVPProxyPath }
