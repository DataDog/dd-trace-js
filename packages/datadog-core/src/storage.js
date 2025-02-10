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
 */
class DatadogStorage extends AsyncLocalStorage {
  /**
   *
   * @param store {DatadogStorage}
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
   * @returns {{}}
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
   *
   * @param handle {{}}
   * @returns {T | undefined}
   */
  getStore (handle) {
    if (!handle) {
      handle = super.getStore()
    }

    return stores.get(handle)
  }

  /**
   * Here, we replicate the behavior of the original `run()` method. We ensure
   * that our `enterWith()` is called internally, so that the handle to the
   * store is set. As an optimization, we use super for getStore and enterWith
   * when dealing with the parent store, so that we don't have to access the
   * WeakMap.
   * @template R
   * @template TArgs extends any[]
   * @param store {DatadogStorage}
   * @param fn {() => R}
   * @param args {TArgs}
   * @returns {void}
   */
  run (store, fn, ...args) {
    const prior = super.getStore()
    this.enterWith(store)
    try {
      return Reflect.apply(fn, null, args)
    } finally {
      super.enterWith(prior)
    }
  }
}

/**
 * This is the map from handles to real stores, used in the class above.
 * @template T
 * @type {WeakMap<WeakKey, T>}
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
 * @param namespace {string} the namespace to use
 * @returns {DatadogStorage}
 */
function storage (namespace) {
  if (!storages[namespace]) {
    storages[namespace] = new DatadogStorage()
  }
  return storages[namespace]
}

module.exports = { storage }
