'use strict'

process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false'

// If this is a release PR, set the SSI variables.
if (/^v\d+\.x$/.test(process.env.GITHUB_BASE_REF || '')) {
  process.env.DD_INJECTION_ENABLED = 'true'
  process.env.DD_INJECT_FORCE = 'true'
}

// Lower max listeners to notice when we add too many listeners early.
// Override per-test, if absolutely necessary.
require('events').defaultMaxListeners = 6

process.on('warning', (warning) => {
  if (warning.name === 'MaxListenersExceededWarning' && !warning.message.includes('[Runner]')) {
    throw warning
  }
})

// Make this file a module for type-aware tooling. It is intentionally imported
// for side effects only.
module.exports = {}
