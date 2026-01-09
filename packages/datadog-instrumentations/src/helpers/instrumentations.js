'use strict'

// Use a global symbol to prevent stealthy-require to interfere.

const sym = Symbol.for('_ddtrace_instrumentations')
globalThis[sym] ??= {}

module.exports = globalThis[sym]
