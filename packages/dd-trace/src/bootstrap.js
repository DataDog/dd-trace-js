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
        try {
          handler()
        } catch (error) {
          try {
            require('./log').error('Error running a beforeExit handler', error)
          } catch {
            // Never let one shutdown handler prevent the remaining handlers.
          }
        }
      }
    }
  })

  const TracerProxy = require('.')

  Object.defineProperty(global, '_ddtrace', {
    value: new TracerProxy(),
    enumerable: false,
    configurable: true,
    writable: true,
  })
}

module.exports = global._ddtrace
// Static aliases so cjs-module-lexer surfaces them as ESM named exports
// (`import { tracer } from 'dd-trace'`).
module.exports.tracer = global._ddtrace
module.exports.default = global._ddtrace
