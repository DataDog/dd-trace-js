'use strict'

const asyncHooks = require('async_hooks')
const Base = require('./base')

let singleton = null

class Scope extends Base {
  constructor () {
    if (singleton) return singleton

    super()

    singleton = this

    this._current = null
    this._spans = new Map()
    this._stack = []
    this._hook = asyncHooks.createHook({
      init: this._init.bind(this),
      before: this._before.bind(this),
      after: this._after.bind(this),
      destroy: this._destroy.bind(this)
    })

    this._hook.enable()
  }

  _active () {
    return this._current
  }

  _activate (span, callback) {
    this._enter(span)

    try {
      return callback()
    } finally {
      this._exit()
    }
  }

  _enter (span) {
    this._stack.push(this._current)
    this._current = span
  }

  _exit () {
    this._current = this._stack.pop()
  }

  _init (asyncId, type, triggerAsyncId, resource) {
    this._spans.set(asyncId, this._current)
  }

  _before (asyncId) {
    this._enter(this._spans.get(asyncId))
  }

  _after () {
    this._exit()
  }

  _destroy (asyncId) {
    this._spans.delete(asyncId)
  }
}

module.exports = Scope
