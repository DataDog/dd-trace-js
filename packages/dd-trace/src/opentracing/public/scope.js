'use strict'

const PublicSpan = require('./span')

class Scope {
  constructor (scope) {
    this._scope = scope
  }

  active () {
    const span = this._scope.active()
    return span ? PublicSpan.wrap(span) : null
  }

  activate (span, fn) {
    return this._scope.activate(span, fn)
  }

  bind (fn, span) {
    return this._scope.bind(fn, span)
  }
}

module.exports = Scope
