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

    this._enabled = true
    this._hook.enable()
  }

  disable () {
    this._reset()
    this._hook.disable()
  }

  getStore () {
    return this._current
  }

  run (store, callback, ...args) {
    const active = this.getStore()

    this._enter(store)

    try {
      return callback(...args)
    } finally {
      this._exit(active)
    }
  }

  _reset () {
    this._current = null
    this._stores = new Map()
    this._types = new Map()
    this._weaks = new WeakMap()
    this._promises = [false]
    this._stack = []
    this._depth = 0
  }

  _enter (store) {
    this._depth++
    this._stack[this._depth] = this._current
    this._current = store
    this._promises[this._depth] = false
  }

  _exit (store) {
    this._await(store)
    this._current = store
    this._stack[this._depth] = null
    this._depth--
  }

  _exitNative () {
    this._current = null
    this._promises[0] = false
  }

  _await (store) {
    if (!this._promises[this._depth]) return

    this._enabled = false
    this._awaitAsync(store)
    this._enabled = true
  }

  // https://github.com/nodejs/node/issues/22360
  async _awaitAsync (store) {
    await {
      then: (resolve) => {
        this._current = store
        resolve()
      }
    }
  }

  _initPromise () {
    if (!this._promises[this._depth]) {
      this._promises[this._depth] = true
      this._await(this._current)
    }
  }

  _init (asyncId, type, triggerAsyncId, resource) {
    if (!this._enabled) return

    this._stores.set(asyncId, this._current)
    this._types.set(asyncId, type)

    if (type === 'PROMISE') {
      this._initPromise()
    }
  }

  _before (asyncId) {
    this._depth === 0 && this._exitNative()
    this._enter(this._stores.get(asyncId))
  }

  _after () {
    this._exit(this._stack[this._depth])
  }

  _destroy (asyncId) {
    this._stores.delete(asyncId)
    this._types.delete(asyncId)
  }
}

module.exports = AsyncHooksStorage
