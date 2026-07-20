'use strict'

const { storage } = require('../../datadog-core')
const { hasNativeEnterWith } = require('../../datadog-core/src/storage')

const legacyStorage = storage('legacy')

/**
 * Shared by both `activate()` strategies below so error-tagging stays identical between them.
 *
 * @param {import('opentracing').Span | undefined} span
 * @param {Error} error
 */
function setErrorTag (span, error) {
  if (span && typeof span.setTag === 'function') {
    span.setTag('error', error)
  }
}

/**
 * Selected when the runtime supports `enterWith()` (every Node release).
 *
 * @param {Record<string, unknown>} newStore
 * @param {Record<string, unknown> | undefined} oldStore
 * @param {import('opentracing').Span | undefined} span
 * @param {() => unknown} callback
 * @returns {unknown}
 */
function activateWithEnterWith (newStore, oldStore, span, callback) {
  legacyStorage.enterWith(newStore)

  try {
    return callback()
  } catch (e) {
    setErrorTag(span, e)

    throw e
  } finally {
    legacyStorage.enterWith(oldStore)
  }
}

/**
 * The store reverts automatically to whatever was active before this call once `callback`
 * settles, including across `await`/timers inside it. Selected when the runtime has no native
 * `enterWith()` (e.g. workerd).
 *
 * @param {Record<string, unknown>} newStore
 * @param {Record<string, unknown> | undefined} oldStore
 * @param {import('opentracing').Span | undefined} span
 * @param {() => unknown} callback
 * @returns {unknown}
 */
function activateWithRun (newStore, oldStore, span, callback) {
  return legacyStorage.run(newStore, () => {
    try {
      return callback()
    } catch (e) {
      setErrorTag(span, e)

      throw e
    }
  })
}

// Decided once at module load, not per `activate()` call, so the hot path never feature-detects.
const activateStore = hasNativeEnterWith ? activateWithEnterWith : activateWithRun

// TODO: refactor bind to use shimmer once the new internal tracer lands
class Scope {
  active () {
    const store = legacyStorage.getStore()

    return store?.span ?? null
  }

  activate (span, callback) {
    if (typeof callback !== 'function') return callback

    const oldStore = legacyStorage.getStore()
    const newStore = span ? legacyStorage.getStore(span._store) : oldStore

    return activateStore({ ...newStore, span }, oldStore, span, callback)
  }

  bind (fn, span) {
    if (typeof fn !== 'function') return fn

    const scope = this
    const spanOrActive = this._spanOrActive(span)

    return function (...args) {
      return scope.activate(spanOrActive, () => {
        return fn.apply(this, args)
      })
    }
  }

  _spanOrActive (span) {
    return span === undefined ? this.active() : span
  }

  _isPromise (promise) {
    return promise && typeof promise.then === 'function'
  }
}

module.exports = Scope
