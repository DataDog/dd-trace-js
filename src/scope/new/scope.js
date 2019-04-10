'use strict'

const asyncHooks = require('../async_hooks')
const executionAsyncId = asyncHooks.executionAsyncId
const Base = require('./base')
const platform = require('../../platform')

let singleton = null

class Scope extends Base {
  constructor (options) {
    if (singleton) return singleton

    super()

    singleton = this

    this._spans = Object.create(null)
    this._types = Object.create(null)
    this._hook = asyncHooks.createHook({
      init: this._init.bind(this),
      destroy: this._destroy.bind(this),
      promiseResolve: this._destroy.bind(this)
    })

    this._hook.enable()
  }

  _active () {
    return this._spans[executionAsyncId()] || null
  }

  _activate (span, callback) {
    const asyncId = executionAsyncId()
    const oldSpan = this._spans[asyncId]

    this._spans[asyncId] = span

    try {
      return callback()
    } catch (e) {
      if (span && typeof span.addTags === 'function') {
        span.addTags({
          'error.type': e.name,
          'error.msg': e.message,
          'error.stack': e.stack
        })
      }

      throw e
    } finally {
      if (oldSpan) {
        this._spans[asyncId] = oldSpan
      } else {
        delete this._spans[asyncId]
      }
    }
  }

  _init (asyncId, type) {
    this._spans[asyncId] = this._active()
    this._types[asyncId] = type

    platform.metrics().increment('async.resources')
    platform.metrics().increment('async.resources.by.type', `resource_type:${type}`)
  }

  _destroy (asyncId) {
    const type = this._types[asyncId]

    if (type) {
      platform.metrics().decrement('async.resources')
      platform.metrics().decrement('async.resources.by.type', `resource_type:${type}`)
    }

    delete this._spans[asyncId]
    delete this._types[asyncId]
  }
}

module.exports = Scope
