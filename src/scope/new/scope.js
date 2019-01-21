'use strict'

const asyncHooks = require('../async_hooks')
const Base = require('./base')

let singleton = null

class Scope extends Base {
  constructor () {
    if (singleton) return singleton

    super()

    singleton = this

    this._spans = new Map()
    this._hook = asyncHooks.createHook({
      init: this._init.bind(this),
      destroy: this._destroy.bind(this),
      promiseResolve: this._destroy.bind(this)
    })

    this._hook.enable()
  }

  _active () {
    return this._spans.get(asyncHooks.executionAsyncId())
  }

  _activate (span, callback) {
    const asyncId = asyncHooks.executionAsyncId()
    const oldSpan = this._spans.get(asyncId)

    this._spans.set(asyncId, span)

    try {
      return callback()
    } catch (e) {
      span && span.addTags({
        'error.type': e.name,
        'error.msg': e.message,
        'error.stack': e.stack
      })

      throw e
    } finally {
      if (oldSpan) {
        this._spans.set(asyncId, oldSpan)
      } else {
        this._destroy(asyncId)
      }
    }
  }

  _init (asyncId) {
    const span = this._spans.get(asyncHooks.executionAsyncId())

    if (span) {
      this._spans.set(asyncId, span)
    }
  }

  _destroy (asyncId) {
    this._spans.delete(asyncId)
  }
}

module.exports = Scope
