'use strict'

const asyncListener = require('@datadog/async-listener')
const Base = require('./base')

let singleton = null

class Scope extends Base {
  constructor () {
    if (singleton) return singleton

    super()

    singleton = this

    this._stack = []
    this._listener = asyncListener.addAsyncListener({
      create: () => this._active(),
      before: (context, storage) => this._enter(storage),
      after: (context, storage) => this._exit(),
      error: (storage) => this._exit()
    })
  }

  _active () {
    return this._stack[this._stack.length - 1]
  }

  _enter (span) {
    this._stack.push(span)
  }

  _exit () {
    this._stack.pop()
  }
}

module.exports = Scope
