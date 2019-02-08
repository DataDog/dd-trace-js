'use strict'

const asyncHooks = require('../async_hooks')
const executionAsyncId = asyncHooks.executionAsyncId
const Base = require('./base')

let singleton = null

class Scope extends Base {
  constructor () {
    if (singleton) return singleton

    super()

    singleton = this

    this._spans = Object.create(null)
    this._hook = asyncHooks.createHook({
      init: this._init.bind(this),
      destroy: this._destroy.bind(this),
      promiseResolve: this._destroy.bind(this)
    })

    this._hook.enable()
  }

  _active () {
    return this._spans[executionAsyncId()]
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
        this._destroy(asyncId)
      }
    }
  }

  _init (asyncId) {
    const span = this._spans[executionAsyncId()]

    if (span) {
      this._spans[asyncId] = span
    }
  }

  _destroy (asyncId) {
    delete this._spans[asyncId]
  }
}

module.exports = Scope
