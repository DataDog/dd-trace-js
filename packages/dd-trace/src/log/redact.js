'use strict'

const { obfuscateQs, redactUrlCredentials } = require('../plugins/util/url')

/**
 * Remove all query parameters and mask URL credentials before diagnostic serialization.
 * @param {string | undefined} endpoint
 */
function redactEndpoint (endpoint) {
  if (endpoint === undefined) return null

  endpoint = obfuscateQs({ queryStringObfuscation: true }, endpoint)
  if (!endpoint.includes('@')) return endpoint

  try {
    const url = new URL(endpoint)
    if (!url.username && !url.password) return endpoint
    return redactUrlCredentials(url.href)
  } catch {
    // Do not expose potential credentials if a calculated endpoint cannot be parsed.
    return null
  }
}

/**
 * Header names are useful diagnostics; every value can contain a credential.
 * @param {Record<string, string> | undefined} headers
 */
function redactHeaders (headers) {
  return Object.fromEntries(Object.keys(headers ?? {}).map(name => [name, '<redacted>']))
}

module.exports = { redactEndpoint, redactHeaders }
