'use strict'

class SyncStorage {
  constructor () {
    this.disable()
  }

  disable () {
    this._stack = []
    this._current = null
  }

  getStore () {
    return this._current || null
  }

  run (store, callback, ...args) {
    this._stack.push(this._current)
    this._current = store

    try {
      return callback(...args)
    } finally {
      this._current = this._stack.pop()
    }
  }
}

module.exports = SyncStorage
