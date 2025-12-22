'use strict'

process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false'

// If this is a release PR, set the SSI variables.
if (/^v\d+\.x$/.test(process.env.GITHUB_BASE_REF || '')) {
  process.env.DD_INJECTION_ENABLED = 'true'
  process.env.DD_INJECT_FORCE = 'true'
}

// Make this file a module for type-aware tooling. It is intentionally imported
// for side effects only.
module.exports = {}
