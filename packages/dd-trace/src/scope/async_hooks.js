'use strict'

const asyncHooks = require('async_hooks')
const Base = require('./base')
const metrics = require('../metrics')
const semver = require('semver')

// fixed in https://github.com/nodejs/node/pull/33801
const hasThenableBug = !semver.satisfies(process.version, '>=14.5 || ^12.19.0')

let singleton = null

class Scope extends Base {
  constructor (config) {
    if (singleton) return singleton

    super()

    singleton = this

    this._trackAsyncScope = config.trackAsyncScope && hasThenableBug
    this._debug = config.debug
    this._current = null
    this._spans = new Map()
    this._types = new Map()
    this._weaks = new WeakMap()
    this._promises = [false]
    this._stack = []
    this._depth = 0
    this._hook = asyncHooks.createHook({
      init: this._init.bind(this),
      before: this._before.bind(this),
      after: this._after.bind(this),
      destroy: this._destroy.bind(this)
    })

    this._enabled = true
    this._hook.enable()
  }

  _active () {
    return this._current
  }

  _activate (span, callback) {
    const active = this._active()

    this._enter(span)

    try {
      return callback()
    } finally {
      this._exit(active)
    }
  }

  _enter (span) {
    this._depth++
    this._stack[this._depth] = this._current
    this._current = span
    this._promises[this._depth] = false
  }

  _exit (span) {
    this._trackAsyncScope && this._await(span)
    this._current = span
    this._stack[this._depth] = null
    this._depth--
  }

  _exitNative () {
    this._current = null
    this._promises[0] = false
  }

  _await (span) {
    if (!this._promises[this._depth]) return

    this._enabled = false
    this._awaitAsync(span)
    this._enabled = true
  }

  // https://github.com/nodejs/node/issues/22360
  async _awaitAsync (span) {
    await {
      then: (resolve) => {
        this._current = span
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

    this._spans.set(asyncId, this._current)
    this._types.set(asyncId, type)

    if (this._debug) {
      metrics.increment('runtime.node.async.resources')
      metrics.increment('runtime.node.async.resources.by.type', `resource_type:${type}`)
    }

    if (this._trackAsyncScope && type === 'PROMISE') {
      this._initPromise()
    }
  }

  _before (asyncId) {
    this._depth === 0 && this._exitNative()
    this._enter(this._spans.get(asyncId))
  }

  _after () {
    this._exit(this._stack[this._depth])
  }

  _destroy (asyncId) {
    const type = this._types.get(asyncId)

    if (type && this._debug) {
      metrics.decrement('runtime.node.async.resources')
      metrics.decrement('runtime.node.async.resources.by.type', `resource_type:${type}`)
    }

    this._spans.delete(asyncId)
    this._types.delete(asyncId)
  }
}

module.exports = Scope
