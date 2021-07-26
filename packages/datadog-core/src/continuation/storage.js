'use strict'

// TODO: Remove the ability to bind event emitters as it can cause issues.

const semver = require('semver')

// https://github.com/nodejs/node/pull/33801
const hasJavaScriptAsyncHooks = semver.satisfies(process.versions.node, '>=14.5 || ^12.19.0')

class ContinuationLocalStorage {
  constructor () {
    this._backend = null
  }

  enable (name) {
    if (this._backend) return

    this._backend = this._getBackend(name)
  }

  disable () {
    if (!this._backend) return

    this._backend.disable()
    this._backend = null
  }

  run (store, callback, ...args) {
    if (!this._backend) return callback(...args)

    return this._backend.run(store, callback, ...args)
  }

  getStore () {
    if (!this._backend) return

    return this._backend.getStore()
  }

  _getBackend (name) {
    if (name === 'noop') return null

    const StorageBackend = this._getBackendClass(name)

    return new StorageBackend()
  }

  _getBackendClass (name) {
    if (name === 'sync') {
      return require('./backends/sync')
    } else if (name === 'async_local_storage') {
      return require('async_hooks').AsyncLocalStorage
    } else if (name === 'async_resource' || (!name && hasJavaScriptAsyncHooks)) {
      return require('./backends/async_resource')
    } else {
      return require('./backends/async_hooks')
    }
  }
}

module.exports = ContinuationLocalStorage
