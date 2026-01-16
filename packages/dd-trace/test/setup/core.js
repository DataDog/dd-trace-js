'use strict'

process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false'

// If this is a release PR, set the SSI variables.
if (/^v\d+\.x$/.test(process.env.GITHUB_BASE_REF || '')) {
  process.env.DD_INJECTION_ENABLED = 'true'
  process.env.DD_INJECT_FORCE = 'true'
}

// Ensure the global dd-trace symbol is always defined, even if the tracer is not loaded.
if (!globalThis[Symbol.for('dd-trace')]) {
  const object = {
    beforeExitHandlers: new Set(),
  }

  Object.defineProperty(globalThis, Symbol.for('dd-trace'), {
    value: object,
    enumerable: false,
    configurable: true, // Allow this to be overridden by loading the tracer
    writable: false,
  })

  process.once('beforeExit', function testBeforeExit () {
    // Only run the beforeExit handlers if the object is still the same.
    // That way we run the original beforeExit handler if it was added after this one.
    if (globalThis[Symbol.for('dd-trace')] === object) {
      for (const handler of globalThis[Symbol.for('dd-trace')].beforeExitHandlers) {
        handler()
      }
    }
  })
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
