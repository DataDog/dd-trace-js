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

  // OpenFeature is intentionally not registered in the Electron build.
  const TracerProxy = require('./src')

  Object.defineProperty(global, '_ddtrace', {
    value: new TracerProxy(),
    enumerable: false,
    configurable: true,
    writable: true,
  })
}

module.exports = global._ddtrace
// Static aliases so cjs-module-lexer surfaces them as ESM named exports
// (`import { tracer } from 'dd-trace-electron'`).
module.exports.tracer = global._ddtrace
module.exports.default = global._ddtrace
