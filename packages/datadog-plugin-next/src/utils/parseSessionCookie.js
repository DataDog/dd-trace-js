'use strict'

// Parses the Datadog RUM session ID from the `_dd_s` cookie value.
// Format: key1=value1&key2=value2 — we extract the `id` entry.
// Duplicated from @datadog/browser-core sessionStateValidation to avoid a cross-package dependency.

const SESSION_ENTRY_REGEXP = /^([a-zA-Z]+)=([a-z0-9-]+)$/
const SESSION_ENTRY_SEPARATOR = '&'

function parseRumSessionId (cookieValue) {
  if (!cookieValue) return undefined

  const entries = cookieValue.split(SESSION_ENTRY_SEPARATOR)
  for (const entry of entries) {
    const match = SESSION_ENTRY_REGEXP.exec(entry)
    if (match !== null) {
      const [, key, value] = match
      if (key === 'id') return value
    }
  }

  return undefined
}

module.exports = { parseRumSessionId }
