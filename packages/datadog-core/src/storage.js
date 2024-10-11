'use strict'

const { AsyncLocalStorage } = require('async_hooks')

const storages = Object.create(null)
const legacyStorage = new AsyncLocalStorage()

const storage = function (namespace) {
  if (!storages[namespace]) {
    storages[namespace] = new AsyncLocalStorage()
  }
  return storages[namespace]
}

storage.enterWith = legacyStorage.enterWith.bind(legacyStorage)
storage.exit = legacyStorage.exit.bind(legacyStorage)
storage.getStore = legacyStorage.getStore.bind(legacyStorage)
storage.run = legacyStorage.run.bind(legacyStorage)

module.exports = storage
