'use strict'

// Parses the Datadog RUM session ID from a `Cookie` header.
// The `_dd_s` cookie value is itself a `key=value&key=value` string — we extract
// the `id` entry in a single pass over the full Cookie header.
// Duplicated from @datadog/browser-core sessionStateValidation to avoid a cross-package dependency.

// (?:^|;\s*)_dd_s=     anchor to the actual _dd_s cookie (not an embedded substring)
// (?:[^;]*&)?          skip any leading entries inside the _dd_s value
// id=([a-z0-9-]+)      capture the id, matching the same character class as the source
const DD_S_ID_REGEXP = /(?:^|;\s*)_dd_s=(?:[^;]*&)?id=([a-z0-9-]+)/

/**
 * @param {string | string[] | undefined} cookieHeader
 * @returns {string | undefined}
 */
function parseRumSessionId (cookieHeader) {
  if (!cookieHeader) return

  const header = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader
  const match = DD_S_ID_REGEXP.exec(header)
  if (match !== null) return match[1]
}

module.exports = { parseRumSessionId }
