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
      create: (storage) => this._active(),
      before: (context, storage) => this._enter(storage),
      after: (context, storage) => this._exit(),
      error: (storage, error) => this._exit()
    })
  }

  _active () {
    return this._span
  }

  _enter (span) {
    this._span = span
  }

  _exit (span) {
    this._span = span
  }
}

module.exports = Scope
