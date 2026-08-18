'use strict'

const { AsyncLocalStorage } = require('node:async_hooks')

const log = require('../../dd-trace/src/log')

const DD_CYPRESS_USER_HANDLER_CONTEXT = Symbol.for('dd-trace.cypress.user-handler.context')
const userHandlerContext = globalThis[DD_CYPRESS_USER_HANDLER_CONTEXT] ||= new AsyncLocalStorage()
const manualPluginOwner = {}

/**
 * Runs a Cypress user handler while allowing wrapped legacy Datadog helpers to
 * defer to the managed finalizer.
 *
 * @param {() => unknown} handler user handler invocation
 * @returns {unknown} handler result
 */
function runUserHandler (handler) {
  return userHandlerContext.run(true, handler)
}

/**
 * @returns {boolean} whether a managed finalizer owns the current lifecycle event
 */
function shouldDeferLegacyFinalization () {
  return userHandlerContext.getStore() === true
}

/**
 * Converts a Cypress rejection reason into error metadata without changing the
 * value rethrown to Cypress.
 *
 * @param {unknown} reason rejection reason
 * @returns {Error} error used for Test Optimization finalization
 */
function normalizeUserHandlerError (reason) {
  if (reason instanceof Error) return reason
  if (reason == null) return new Error('Cypress user handler rejected without an error')

  try {
    return new Error(String(reason))
  } catch {
    return new Error('Cypress user handler failed')
  }
}

/**
 * Runs the Datadog finalizer after user handlers while preserving the user
 * error as the framework-visible failure.
 *
 * @param {Promise<void>} userHandlers collected user-handler chain
 * @param {(userError?: unknown) => unknown} finalizer Datadog finalizer
 * @returns {Promise<unknown>} finalizer result
 */
function finalizeAfterUserHandlers (userHandlers, finalizer) {
  return userHandlers.then(
    () => finalizer(),
    userError => Promise.resolve().then(() => {
      return finalizer(normalizeUserHandlerError(userError))
    }).then(
      () => { throw userError },
      finalizerError => {
        log.error('Datadog Cypress finalizer failed after a user handler error', finalizerError)
        throw userError
      }
    )
  )
}

module.exports = {
  finalizeAfterUserHandlers,
  manualPluginOwner,
  normalizeUserHandlerError,
  runUserHandler,
  shouldDeferLegacyFinalization,
}
