'use strict'

const sym = Symbol.for('_ddtrace_instrumentations')

global[sym] ||= {}

module.exports = global[sym]
