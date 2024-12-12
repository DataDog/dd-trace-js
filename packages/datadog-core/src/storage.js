'use strict'

const { AsyncLocalStorage } = require('async_hooks')

class DatadogStorage {
  constructor () {
    this._storage = new AsyncLocalStorage()
  }

  disable () {
    this._storage.disable()
  }

  enterWith (store) {
    const handle = {}
    stores.set(handle, store)
    this._storage.enterWith(handle)
  }

  exit (callback, ...args) {
    this._storage.exit(callback, ...args)
  }

  getStore () {
    const handle = this._storage.getStore()
    return stores.get(handle)
  }

  run (store, fn, ...args) {
    const prior = this._storage.getStore()
    this.enterWith(store)
    try {
      return Reflect.apply(fn, null, args)
    } finally {
      this._storage.enterWith(prior)
    }
  }
}

const storages = Object.create(null)
const legacyStorage = new DatadogStorage()

const storage = function (namespace) {
  if (!storages[namespace]) {
    storages[namespace] = new DatadogStorage()
  }
  return storages[namespace]
}

storage.disable = legacyStorage.disable.bind(legacyStorage)
storage.enterWith = legacyStorage.enterWith.bind(legacyStorage)
storage.exit = legacyStorage.exit.bind(legacyStorage)
storage.getStore = legacyStorage.getStore.bind(legacyStorage)
storage.run = legacyStorage.run.bind(legacyStorage)

const stores = new WeakMap()

module.exports = storage
