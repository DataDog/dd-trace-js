'use strict'

const { createHook, executionAsyncResource } = require('async_hooks')
class AsyncResourceStorage {
  constructor (config) {
    this._ddResourceStore = Symbol('ddResourceStore')
    this._config = config
    this._stack = []
    this._hook = createHook({
      init: this._init.bind(this)
    })

    this._hook.enable()
  }

  disable () {
    this._stack = []
    this._hook.disable()
  }

  getStore () {
    const resource = this._activeResource()

    return resource[this._ddResourceStore]
  }

  run (store, callback, ...args) {
    const resource = this._activeResource()

    this._enter(store, resource)

    try {
      return callback(...args)
    } finally {
      this._exit(resource)
    }
  }

  _activeResource () {
    return executionAsyncResource() || {}
  }

  _enter (store, resource) {
    this._stack.push(resource[this._ddResourceStore])
    resource[this._ddResourceStore] = store
  }

  _exit (resource) {
    resource[this._ddResourceStore] = this._stack.pop()
  }

  _init (asyncId, type, triggerAsyncId, resource) {
    const triggerResource = this._activeResource()
    const store = triggerResource[this._ddResourceStore]

    if (store) {
      resource[this._ddResourceStore] = store
    }
  }
}

module.exports = AsyncResourceStorage
