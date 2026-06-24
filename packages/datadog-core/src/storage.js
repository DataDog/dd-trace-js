'use strict'

const { AsyncLocalStorage } = require('async_hooks')

/**
 * `AsyncLocalStorage` with a `getHandle()` escape hatch: a span stashes the
 * active handle at creation (see opentracing/span.js) so a later context can
 * recover its store without holding the store itself.
 *
 * Under AsyncContextFrame — Node's default ALS backend on every release that
 * ships it — the active value lives in the context frame and is never written
 * to the async resource, so the store is held directly and the handle is the
 * store. Pre-ACF `async_hooks` instead pinned the value onto the resource
 * object, where it was visible to logging and retained with the resource
 * graph; the `!isACFActive` block below restores the original WeakMap-handle
 * indirection that kept the real store off the resource on those runtimes.
 *
 * @template T
 * @typedef {Record<string, T>} Store
 */
class DatadogStorage extends AsyncLocalStorage {
  /**
   * Passthrough to the real `getStore()`. A span stashes this handle and feeds
   * it back to `getStore(handle)` later. Identical in both modes: under ACF the
   * handle is the store; without ACF it is the WeakMap key.
   *
   * @returns {Store<unknown>}
   */
  getHandle () {
    return super.getStore()
  }

  /**
   * @param {Store<unknown>} [handle] A handle from `getHandle()`; defaults to
   * the active one. Under ACF the handle is the store, so it is returned as-is.
   * @returns {Store<unknown> | undefined}
   * @override
   */
  getStore (handle) {
    return handle ?? super.getStore()
  }
}

// To handle all versions always correct, feature detect AsyncContextFrame and
// fallback to manual approach if not active. With ACF `run` delegates to
// `enterWith`, without ACF `run` does not.
const isACFActive = (() => {
  let active = false
  const als = new AsyncLocalStorage()
  als.enterWith = () => { active = true }
  als.run(1, () => {})
  als.disable()
  return active
})()

if (!isACFActive) {
  const superGetStore = AsyncLocalStorage.prototype.getStore
  const superEnterWith = AsyncLocalStorage.prototype.enterWith

  // Without ACF, ALS writes the entered value onto the async resource. Keep the
  // real store off the resource by entering a small handle and mapping it to
  // the store through a WeakMap, then reversing the lookup on read.
  const stores = new WeakMap()

  /**
   * @param {Store<unknown>} [store]
   */
  DatadogStorage.prototype.enterWith = function enterWith (store) {
    const handle = { noop: store?.noop }
    stores.set(handle, store)
    superEnterWith.call(this, handle)
  }

  /**
   * @param {object} [handle]
   * @returns {Store<unknown> | undefined}
   */
  DatadogStorage.prototype.getStore = function getStore (handle) {
    if (!handle) {
      handle = superGetStore.call(this)
    }
    if (handle) {
      return stores.get(handle)
    }
  }

  /**
   * Without ACF, `super.run()` does not delegate to `enterWith()`, so the
   * WeakMap handle is never created and `getStore()` would miss. Drive the
   * handle path manually and restore the prior handle on the way out.
   *
   * @template R
   * @template {unknown[]} TArgs
   * @param {Store<unknown>} store
   * @param {(...args: TArgs) => R} fn
   * @param {TArgs} args
   * @returns {R}
   * @override
   */
  DatadogStorage.prototype.run = function run (store, fn, ...args) {
    const prior = superGetStore.call(this)
    this.enterWith(store)
    try {
      return Reflect.apply(fn, null, args)
    } finally {
      superEnterWith.call(this, prior)
    }
  }
}

/**
 * For convenience, we use the `storage` function as a registry of namespaces
 * corresponding to DatadogStorage instances. This lets us have separate
 * storages for separate purposes.
 * @type {Map<string, DatadogStorage>}
 */
const storages = Object.create(null)

/**
 *
 * @param {string} namespace The namespace to use
 * @returns {DatadogStorage}
 */
function storage (namespace) {
  if (!storages[namespace]) {
    storages[namespace] = new DatadogStorage()
  }
  return storages[namespace]
}

module.exports = { storage, isACFActive }
