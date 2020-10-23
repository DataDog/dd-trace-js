'use strict'

const { createHook, executionAsyncResource } = require('async_hooks')
const Base = require('./base')

class Scope extends Base {
  constructor (config) {
    super()

    this._ddResourceStore = Symbol('ddResourceStore')
    this._config = config
    this._stack = []
    this._hook = createHook({
      init: this._init.bind(this)
    })

    this.enable()
  }

  enable () {
    this._enabled = true
    this._hook.enable()
  }

  disable () {
    this._enabled = false
    this._stack = []
    this._hook.disable()
  }

  _active () {
    if (!this._enabled) return null

    const resource = executionAsyncResource()

    return resource[this._ddResourceStore] || null
  }

  _activate (span, callback) {
    if (!this._enabled) return callback()

    const resource = executionAsyncResource()

    this._enter(span, resource)

    try {
      return callback()
    } finally {
      this._exit(resource)
    }
  }

  _enter (span, resource) {
    this._stack.push(resource[this._ddResourceStore])
    resource[this._ddResourceStore] = span
  }

  _exit (resource) {
    resource[this._ddResourceStore] = this._stack.pop()
  }

  _init (asyncId, type, triggerAsyncId, resource) {
    const triggerResource = executionAsyncResource()
    const span = triggerResource[this._ddResourceStore]

    if (span) {
      resource[this._ddResourceStore] = span
    }
  }
}

module.exports = Scope
