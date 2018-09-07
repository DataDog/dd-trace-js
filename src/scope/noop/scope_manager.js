'use strict'

const Scope = require('./scope')

let singleton = null

class ScopeManager {
  constructor () {
    if (!singleton) {
      singleton = this
    }

    return singleton
  }

  active () {
    return null
  }

  activate (span, finishSpanOnClose) {
    return new Scope(span, finishSpanOnClose)
  }
}

module.exports = ScopeManager
