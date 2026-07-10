'use strict'

const log = require('../../log')

let hasWarnedLegacyFormat = false

/**
 * Normalize a plugin's `headers` header-tag config into `[headerName, tagName]`
 * pairs, with the header name lowercased and an empty/absent tag represented as
 * `undefined` (the caller falls back to `http.{request,response}.headers.<header>`).
 * Plugins call this once at configure time so the per-request tagging loop stays a
 * plain array iteration.
 *
 * The going-forward shape is an object (`{ 'x-header': 'my.tag' }`). The legacy
 * `['x-header:my.tag']` array is still accepted with a one-time deprecation warning.
 *
 * @param {Record<string, string> | string[] | undefined} input
 * @returns {Array<[string, string | undefined]>}
 */
function toHeaderTagEntries (input) {
  if (!input) {
    return []
  }

  if (Array.isArray(input)) {
    warnLegacyFormat()
    const result = []
    for (const entry of input) {
      if (typeof entry !== 'string') {
        continue
      }
      const separatorIndex = entry.indexOf(':', entry[0] === ':' ? 1 : 0)
      result.push(separatorIndex === -1
        ? [entry.trim().toLowerCase(), undefined]
        : [entry.slice(0, separatorIndex).trim().toLowerCase(), entry.slice(separatorIndex + 1).trim()])
    }
    return result
  }

  const result = []
  for (const [header, tag] of Object.entries(input)) {
    result.push([header.toLowerCase(), tag || undefined])
  }
  return result
}

function warnLegacyFormat () {
  if (hasWarnedLegacyFormat) {
    return
  }
  hasWarnedLegacyFormat = true
  log.warn('The array form of the plugin `headers` option is deprecated. Pass an object keyed by header name instead.')
}

module.exports = { toHeaderTagEntries }
