'use strict'

const hooks = require('./hooks')

/**
 * Loads an instrumentation module for an explicitly enabled integration.
 * @param {string} name
 * @returns {void}
 */
module.exports = function registerInstrumentation (name) {
  const hook = hooks[name]
  const load = hook?.fn ?? hook

  if (typeof load !== 'function') return

  load()
}
