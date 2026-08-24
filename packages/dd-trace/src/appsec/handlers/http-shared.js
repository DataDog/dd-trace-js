'use strict'

// Per-request state shared by the request and response handlers.
const storedResponseHeaders = new WeakMap()

/**
 * @param {Record<string, unknown>} src
 * @param {string} omit
 * @returns {Record<string, unknown>}
 */
function copyHeadersOmitting (src, omit) {
  const filtered = {}
  for (const key of Object.keys(src)) {
    if (key !== omit) filtered[key] = src[key]
  }
  return filtered
}

module.exports = {
  storedResponseHeaders,
  copyHeadersOmitting,
}
