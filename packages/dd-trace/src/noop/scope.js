'use strict'

class Scope {
  active () {
    return null
  }

  activate (span, callback) {
    if (typeof callback !== 'function') return callback

    return callback()
  }

  bind (fn, span) {
    return fn
  }
}

module.exports = Scope
