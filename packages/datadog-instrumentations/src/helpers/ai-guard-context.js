'use strict'

const { AsyncLocalStorage } = require('node:async_hooks')

const store = new AsyncLocalStorage()

/**
 * Runs `fn` inside an AI Guard context scope.
 *
 * Framework-level instrumentations (e.g. vercel-ai) call this around their own
 * AI Guard evaluation. Provider-SDK instrumentations (e.g. openai) check the
 * flag via {@link isAIGuardContextActive} and skip duplicate evaluation when
 * it is active.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function runWithAIGuardContext (fn) {
  return store.run({ active: true }, fn)
}

/**
 * @returns {boolean} true when the current async execution is inside a
 *   {@link runWithAIGuardContext} scope.
 */
function isAIGuardContextActive () {
  return store.getStore()?.active === true
}

module.exports = { runWithAIGuardContext, isAIGuardContextActive }
