'use strict'

const { AsyncLocalStorage } = require('async_hooks')
const Base = require('./base')

let singleton = null

class Scope extends Base {
  constructor () {
    if (singleton) return singleton

    super()

    singleton = this

    this.enable()
  }

  _disable () {
    if (this.isEnabled())
      this._storage.disable()
  }

  _enable () {
    if (!this.isEnabled())
      this._storage = new AsyncLocalStorage()
  }

  _isEnabled () {
    return !!this._storage
  }

  _active () {
    if (!this.isEnabled()) return null
    const store = this._storage.getStore()
    return typeof store === 'undefined' ? null : store
  }

  _activate (span, callback) {
    if (!this.isEnabled()) return callback()
    return this._storage.run(span, callback)
  }
}

module.exports = Scope
