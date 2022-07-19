'use strict'

const { executionAsyncId } = require('async_hooks')
const AsyncResourceStorage = require('./async_resource')

class AsyncHooksStorage extends AsyncResourceStorage {
  constructor () {
    super()

    this._resources = new Map()
  }

  disable () {
    super.disable()

    this._resources.clear()
  }

  _createHook () {
    return {
      ...super._createHook(),
      destroy: this._destroy.bind(this)
    }
  }

  _init (asyncId, type, triggerAsyncId, resource) {
    super._init.apply(this, arguments)

    this._resources.set(asyncId, resource)
  }

  _destroy (asyncId) {
    this._resources.delete(asyncId)
  }

  _executionAsyncResource () {
    const asyncId = executionAsyncId()

    let resource = this._resources.get(asyncId)

    if (!resource) {
      this._resources.set(asyncId, resource = {})
    }

    return resource
  }
}

module.exports = AsyncHooksStorage
