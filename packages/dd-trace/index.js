'use strict'

if (!global._ddtrace) {
  const ddTraceSymbol = Symbol.for('dd-trace')

  // Set up beforeExitHandlers before loading the tracer so that modules loaded
  // during require('./src') can register handlers.
  Object.defineProperty(globalThis, ddTraceSymbol, {
    value: {
      beforeExitHandlers: new Set(),
    },
    enumerable: false,
    configurable: true,
    writable: false,
  })

  process.once('beforeExit', function mainBeforeExit () {
    if (globalThis[ddTraceSymbol]?.beforeExitHandlers) {
      for (const handler of globalThis[ddTraceSymbol].beforeExitHandlers) {
        handler()
      }
    }
  })

  const TracerProxy = require('./src')

  Object.defineProperty(global, '_ddtrace', {
    value: new TracerProxy(),
    enumerable: false,
    configurable: true,
    writable: true,
  })

  global._ddtrace.default = global._ddtrace
  global._ddtrace.tracer = global._ddtrace
}

module.exports = global._ddtrace
