'use strict'

class NoopStorage {
  disable () {}

  enterWith (store) {}

  run (store, callback, ...args) {
    return callback(...args)
  }

  getStore () {}
}

module.exports = NoopStorage
