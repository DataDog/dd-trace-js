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
    return this._scope.activate(span?._span || span, fn)
  }

  bind (fn, span) {
    return this._scope.bind(fn, span?._span || span)
  }
}

module.exports = Scope
