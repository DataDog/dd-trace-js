'use strict'

// Response headers captured on `responseWriteHead` (http-response) and later read
// when the request finishes (http-request end translator). This is the only piece
// of per-request state shared across the two handler modules.
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
