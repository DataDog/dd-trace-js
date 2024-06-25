'use strict'

const sym = Symbol.for('_ddtrace_esm_instrumentations')

global[sym] = global[sym] || {}

module.exports = global[sym]
