'use strict'

// Use a global symbol to prevent stealthy-require to interfere.
// TODO: Use the symbol from dd-trace instead and remove this file.
const sym = Symbol.for('_ddtrace_instrumentations')
globalThis[sym] ??= {}

module.exports = globalThis[sym]
