'use strict'

class Scope {
  active () {
    return null
  }

  activate (span, callback) {
    if (typeof callback !== 'function') return callback

    return callback()
  }

  bind (target, span) {
    return target
  }

  unbind (target) {
    return target
  }
}

module.exports = new Scope()
