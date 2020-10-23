'use strict'

const { AsyncLocalStorage } = require('async_hooks')
const Base = require('./base')

let singleton = null

class Scope extends Base {
  constructor () {
    if (singleton) return singleton

    super()

    singleton = this

    this._storage = new AsyncLocalStorage()
  }

  _active () {
    const store = this._storage.getStore()
    return typeof store === 'undefined' ? null : store
  }

  _activate (span, callback) {
    return this._storage.run(span, callback)
  }
}

module.exports = Scope
