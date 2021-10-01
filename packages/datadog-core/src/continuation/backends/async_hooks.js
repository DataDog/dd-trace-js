'use strict'

const asyncHooks = require('async_hooks')

class AsyncHooksStorage {
  constructor () {
    this._reset()

    this._hook = asyncHooks.createHook({
      init: this._init.bind(this),
      before: this._before.bind(this),
      after: this._after.bind(this),
      destroy: this._destroy.bind(this)
    })

    this._hook.enable()
  }

  disable () {
    this._reset()
    this._hook.disable()
  }

  getStore () {
    return this._current
  }

  enterWith (store) {
    this._current = store
  }

  run (store, callback, ...args) {
    this._enter(store)

    try {
      return callback(...args)
    } finally {
      this._exit()
    }
  }

  _reset () {
    this._current = undefined
    this._stores = new Map()
    this._stack = []
  }

  _enter (store) {
    this._stack.push(this._current)
    this._current = store
  }

  _exit () {
    this._current = this._stack.pop()
  }

  _init (asyncId, type, triggerAsyncId, resource) {
    this._stores.set(asyncId, this._current)
  }

  _before (asyncId) {
    this._enter(this._stores.get(asyncId))
  }

  _after () {
    this._exit()
  }

  _destroy (asyncId) {
    this._stores.delete(asyncId)
  }
}

module.exports = AsyncHooksStorage
