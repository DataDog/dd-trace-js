'use strict'

const Base = require('./base')

class Scope extends Base {
  constructor () {
    super()

    this._stack = []
    this._current = null
  }

  _active () {
    return this._current || null
  }

  _activate (span, callback) {
    this._stack.push(this._current)
    this._current = span

    try {
      return callback()
    } finally {
      this._current = this._stack.pop()
    }
  }
}

module.exports = Scope
