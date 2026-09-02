'use strict'

const { AsyncResource } = require('node:async_hooks')

const { storage } = require('../../../../datadog-core')
const shimmer = require('../../../../datadog-shimmer')

const legacyStorage = storage('legacy')

/**
 * @param {Function} runInAsyncScope
 * @returns {Function}
 */
function wrapRunInAsyncScope (runInAsyncScope) {
  /**
   * @param {Function} callback
   * @param {unknown} thisArg
   * @returns {unknown}
   */
  return function runInAsyncScopeWithDatadogContext (callback, thisArg) {
    const callerStore = legacyStorage.getStore()
    if (!callerStore?.span || typeof callback !== 'function') {
      return runInAsyncScope.apply(this, arguments)
    }

    arguments[0] = function runWithDatadogContext () {
      if (legacyStorage.getStore() !== undefined) {
        return call(callback, this, arguments)
      }

      return legacyStorage.run(callerStore, call, callback, this, arguments)
    }

    return runInAsyncScope.apply(this, arguments)
  }
}

/**
 * @param {Function} callback
 * @param {unknown} thisArg
 * @param {object} args The callback's `arguments` object.
 * @returns {unknown}
 */
function call (callback, thisArg, args) {
  return Reflect.apply(callback, thisArg, args)
}

// AsyncResource is implemented by Node at runtime, so Orchestrion has no JavaScript source to rewrite.
shimmer.wrap(AsyncResource.prototype, 'runInAsyncScope', wrapRunInAsyncScope)
