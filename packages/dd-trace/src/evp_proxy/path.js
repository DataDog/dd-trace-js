'use strict'

const LEADING_SLASHES = /^\/+/

/**
 * @param {string} value
 * @returns {string}
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
 * @param {...string} paths - URL path components
 * @returns {string} Joined request path
 */
function joinEVPProxyPath (...paths) {
  let joined = ''
  for (const path of paths) {
    const normalized = stripTrailingSlashes(path).replace(LEADING_SLASHES, '')
    if (normalized) joined += `/${normalized}`
  }

  return joined || '/'
}

/**
 * Joins an HTTP Agent URL path prefix with an EVP proxy path.
 * Unix URL pathnames identify the socket itself and are not HTTP path prefixes.
 *
 * @param {URL} url - Configured Agent URL
 * @param {...string} paths - EVP path components
 * @returns {string} Joined request path
 */
function joinAgentURLPath (url, ...paths) {
  const prefix = url.protocol === 'http:' || url.protocol === 'https:' ? url.pathname : ''
  return joinEVPProxyPath(prefix, ...paths)
}

module.exports = { joinAgentURLPath, joinEVPProxyPath, stripTrailingSlashes }
