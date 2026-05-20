'use strict'

// Parses the Datadog RUM session ID from a `Cookie` header.
//
// The browser SDK persists session state under two cookie names:
//   - `_dd_s_v2`  current (SESSION_STORE_KEY)        — preferred when present
//   - `_dd_s`     legacy   (LEGACY_SESSION_STORE_KEY) — read once for migration,
//                                                       not refreshed afterward
// The value in either cookie is itself a `key=value&key=value` string — we
// extract the `id` entry in a single pass over the full Cookie header.
// Format duplicated from @datadog/browser-core sessionStateValidation to avoid
// a cross-package dependency.

// (?:^|;\s*)_dd_s(_v2)?=  anchor to the actual cookie (not an embedded substring)
// (?:[^;]*&)?             skip any leading entries inside the value
// id=([a-z0-9-]+)         capture the id, matching the upstream character class
const DD_S_V2_ID_REGEXP = /(?:^|;\s*)_dd_s_v2=(?:[^;]*&)?id=([a-z0-9-]+)/
const DD_S_ID_REGEXP = /(?:^|;\s*)_dd_s=(?:[^;]*&)?id=([a-z0-9-]+)/

/**
 * @param {string | string[] | undefined} cookieHeader
 * @returns {string | undefined}
 */
function parseRumSessionId (cookieHeader) {
  if (!cookieHeader) return

  const header = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader
  const match = DD_S_V2_ID_REGEXP.exec(header) ?? DD_S_ID_REGEXP.exec(header)
  if (match !== null) return match[1]
}

module.exports = { parseRumSessionId }
