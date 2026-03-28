'use strict'

const PublicSpan = require('./span')

class Scope {
  constructor (scope) {
    this._scope = scope
  }

  active () {
    const span = this._scope.active()
    return span ? new PublicSpan(span) : null
  }

  activate (span, fn) {
    if (span instanceof PublicSpan) {
      span = span._span
    }
    return this._scope.activate(span, fn)
  }

  bind (fn, span) {
    if (span instanceof PublicSpan) {
      span = span._span
    }
    return this._scope.bind(fn, span)
  }
}

module.exports = Scope
