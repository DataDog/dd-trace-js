'use strict'

const { tracingChannel } = require('dc-polyfill')

const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

const ch = tracingChannel('apm:async-mutex:acquire')

/**
 * @param {Function} acquire
 * @returns {(...args: unknown[]) => unknown}
 */
function wrapAcquire (acquire) {
  return function wrappedAcquire () {
    if (!ch.start.hasSubscribers) {
      return acquire.apply(this, arguments)
    }

    const weight = arguments[0] ?? 1
    const priority = arguments[1] ?? 0

    const ctx = {
      weight,
      priority,
      // `_couldLockImmediately` is the library's own predicate for "would this queue". Guarded so
      // a version that drops it reports nothing rather than a wrong answer.
      contended: typeof this._couldLockImmediately === 'function'
        ? !this._couldLockImmediately(weight, priority)
        : undefined,
    }

    return ch.tracePromise(acquire, ctx, this, ...arguments)
  }
}

/** @typedef {{ Semaphore: { prototype: Record<string, unknown> } }} AsyncMutexExports */

addHook({
  name: 'async-mutex',
  versions: ['>=0.5.0'],
}, asyncMutex => {
  const { Semaphore } = /** @type {AsyncMutexExports} */ (asyncMutex)
  shimmer.wrap(Semaphore.prototype, 'acquire', wrapAcquire)
  return asyncMutex
})
