'use strict'

const hooks = require('./hooks')

/**
 * Loads an instrumentation module for an explicitly enabled integration.
 * @param {string} name
 */
module.exports = function registerInstrumentation (name) {
  const hook = hooks[name]
  const register = hook?.fn ?? hook

  if (typeof register === 'function') register()
}
