'use strict'

const { AsyncLocalStorage } = require('async_hooks')

/**
 * This is exactly the same as AsyncLocalStorage, with the exception that it
 * uses a WeakMap to store the store object. This is because ALS stores the
 * store object as a property of the resource object, which causes all sorts
 * of problems with logging and memory. We substitute the `store` object with
 * a "handle" object, which is used as a key in a WeakMap, where the values
 * are the real store objects.
 *
 * @template T
 * @typedef {Record<string, T>} Store
 */
class DatadogStorage extends AsyncLocalStorage {
  /**
   * @param {Store<unknown>} [store]
   * @override
   */
  enterWith (store) {
    const handle = {}
    stores.set(handle, store)
    super.enterWith(handle)
  }

  /**
   * This is method is a passthrough to the real `getStore()`, so that, when we
   * need it, we can use the handle rather than our mapped store.
   *
   * It's only here because stores are currently used for a bunch of things,
   * and we don't want to hold on to all of them in spans
   * (see opentracing/span.js). Using a namespaced storage for spans would
   * solve this.
   *
   * TODO: Refactor the Scope class to use a span-only store and remove this.
   *
   * @returns {Store<unknown>}
   */
  getHandle () {
    return super.getStore()
  }

  /**
   * Here, we replicate the behavior of the original `getStore()` method by
   * passing in the handle, which we retrieve by calling it on super. Handles
   * retrieved through `getHandle()` can also be passed in to be used as the
   * key. This is useful if you've stashed a handle somewhere and want to
   * retrieve the store with it.
   * @param {object} [handle]
   * @returns {Store<unknown> | undefined}
   * @override
   */
  getStore (handle) {
    if (!handle) {
      handle = super.getStore()
    }
    if (handle) {
      return stores.get(handle)
    }
  }
}


// To handle all versions always correct, feature detect AsyncContextFrame and
// fallback to manual approach if not active.
const isACFActive = (() => {
  let active = false
  const als = new AsyncLocalStorage()
  const orig = als.enterWith
  als.enterWith = () => { active = true }
  als.run(1, () => {})
  als.enterWith = orig
  return active
})()

if (!isACFActive) {
  const superGetStore = AsyncLocalStorage.prototype.getStore
  const superEnterWith = AsyncLocalStorage.prototype.enterWith

  /**
   * Override the `run` method to manually call `enterWith` and `getStore`
   * when not using AsyncContextFrame.
   *
   * Without ACF, super.run() won't call this.enterWith(), so the WeakMap handle
   * is never created and getStore() would fail.
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
 * This is the map from handles to real stores, used in the class above.
 * @type {WeakMap<WeakKey, Store<unknown>|undefined>}
 */
const stores = new WeakMap()

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

module.exports = { storage }
