'use strict'

const { AsyncLocalStorage } = require('async_hooks')

class DatadogStorage {
  constructor () {
    this._storage = new AsyncLocalStorage()
  }

  enterWith (store) {
    const handle = {}
    stores.set(handle, store)
    this._storage.enterWith(handle)
  }

  getStore () {
    const handle = this._storage.getStore()
    return stores.get(handle)
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

storage.enterWith = legacyStorage.enterWith.bind(legacyStorage)
storage.getStore = legacyStorage.getStore.bind(legacyStorage)

const stores = new WeakMap()

module.exports = storage
