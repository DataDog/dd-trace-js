'use strict'

const { createHook, executionAsyncResource } = require('async_hooks')
const { channel } = require('diagnostics_channel')

const beforeCh = channel('dd-trace:storage:before')
const afterCh = channel('dd-trace:storage:after')

let PrivateSymbol = Symbol
function makePrivateSymbol () {
  // eslint-disable-next-line no-new-func
  PrivateSymbol = new Function('name', 'return %CreatePrivateSymbol(name)')
}

try {
  makePrivateSymbol()
} catch (e) {
  try {
    const v8 = require('v8')
    v8.setFlagsFromString('--allow-natives-syntax')
    makePrivateSymbol()
    v8.setFlagsFromString('--no-allow-natives-syntax')
  // eslint-disable-next-line no-empty
  } catch (e) {}
}

class AsyncResourceStorage {
  constructor () {
    this._ddResourceStore = PrivateSymbol('ddResourceStore')
    this._enabled = false
    this._hook = createHook(this._createHook())
  }

  disable () {
    if (!this._enabled) return

    this._hook.disable()
    this._enabled = false
  }

  getStore () {
    if (!this._enabled) return

    const resource = this._executionAsyncResource()

    return resource[this._ddResourceStore]
  }

  enterWith (store) {
    this._enable()

    const resource = this._executionAsyncResource()

    resource[this._ddResourceStore] = store
  }

  run (store, callback, ...args) {
    this._enable()

    const resource = this._executionAsyncResource()
    const oldStore = resource[this._ddResourceStore]

    resource[this._ddResourceStore] = store

    try {
      return callback(...args)
    } finally {
      resource[this._ddResourceStore] = oldStore
    }
  }

  _createHook () {
    return {
      init: this._init.bind(this),
      before () {
        beforeCh.publish()
      },
      after () {
        afterCh.publish()
      }
    }
  }

  _enable () {
    if (this._enabled) return

    this._enabled = true
    this._hook.enable()
  }

  _init (asyncId, type, triggerAsyncId, resource) {
    const currentResource = this._executionAsyncResource()

    if (Object.prototype.hasOwnProperty.call(currentResource, this._ddResourceStore)) {
      resource[this._ddResourceStore] = currentResource[this._ddResourceStore]
    }
  }

  _executionAsyncResource () {
    return executionAsyncResource() || {}
  }
}

module.exports = AsyncResourceStorage
