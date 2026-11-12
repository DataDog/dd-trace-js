'use strict'

/** @type {WeakSet<() => void>} */
const finalizers = new WeakSet()

/**
 * Registers synchronous span finalization before ordinary exit handlers flush and stop writers.
 * Handlers remain in the existing set, so its normal registration/removal lifecycle is preserved.
 * @param {() => void} handler
 */
function addBeforeExitFinalizer (handler) {
  finalizers.add(handler)
  globalThis[Symbol.for('dd-trace')]?.beforeExitHandlers?.add(handler)
}

/** @param {Set<() => void>} handlers */
function runBeforeExitHandlers (handlers) {
  for (const handler of handlers) {
    if (!finalizers.has(handler)) continue
    try {
      handler()
    } catch (error) {
      // Lazy to avoid loading the logger while bootstrap creates the lifecycle registry.
      require('./log').error('Error finalizing spans before process exit: %s', error?.message || error)
    }
  }
  for (const handler of handlers) {
    if (!finalizers.has(handler)) handler()
  }
}

module.exports = { addBeforeExitFinalizer, runBeforeExitHandlers }
