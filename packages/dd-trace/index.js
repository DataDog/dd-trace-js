'use strict'

if (!global._ddtrace) {
  const TracerProxy = require('./src')

  Object.defineProperty(global, '_ddtrace', {
    value: new TracerProxy(),
    enumerable: false,
    configurable: true,
    writable: true,
  })

  const ddTraceSymbol = Symbol.for('dd-trace')

  Object.defineProperty(globalThis, ddTraceSymbol, {
    value: {
      beforeExitHandlers: new Set(),
    },
    enumerable: false,
    configurable: true, // Allow this to be overridden by loading the tracer
    writable: false,
  })

  process.once('beforeExit', function mainBeforeExit () {
    if (globalThis[ddTraceSymbol]?.beforeExitHandlers) {
      for (const handler of globalThis[ddTraceSymbol].beforeExitHandlers) {
        handler()
      }
    }
  })

  global._ddtrace.default = global._ddtrace
  global._ddtrace.tracer = global._ddtrace
}

module.exports = global._ddtrace
