'use strict'

const LEADING_SLASHES = /^\/+/

/**
 * @param {string} value
 */
function stripTrailingSlashes (value) {
  let end = value.length
  while (end > 0 && value[end - 1] === '/') end--
  return end === value.length ? value : value.slice(0, end)
}

/**
 * Joins a caller-supplied EVP proxy path and product endpoint.
 *
 * This utility does not perform EVP proxy discovery.
 *
 * @param {string} basePath - EVP proxy base path
 * @param {string} endpoint - Product intake endpoint
 */
function joinEVPProxyPath (basePath, endpoint) {
  const normalizedBasePath = stripTrailingSlashes(basePath)
  const normalizedEndpoint = endpoint.replace(LEADING_SLASHES, '')

  return `${normalizedBasePath}/${normalizedEndpoint}`
}

module.exports = { joinEVPProxyPath, stripTrailingSlashes }
