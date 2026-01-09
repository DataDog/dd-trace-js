'use strict'

if (!global._ddtrace) {
  const TracerProxy = require('./src')

  Object.defineProperty(global, '_ddtrace', {
    value: new TracerProxy(),
    enumerable: false,
    configurable: true,
    writable: true
  })

  const ddTraceSymbol = Symbol.for('dd-trace')

  Object.defineProperty(globalThis, ddTraceSymbol, {
    value: {
      instrumentations: {},
      beforeExitHandlers: new Set(),
    },
    enumerable: false,
    configurable: false,
    writable: false
  })

  process.once('beforeExit', function mainBeforeExit () {
    for (const handler of globalThis[ddTraceSymbol].beforeExitHandlers) {
      handler()
    }
  })

  global._ddtrace.default = global._ddtrace
  global._ddtrace.tracer = global._ddtrace
}

module.exports = global._ddtrace
