'use strict'

const spanActivation = require('./span_activation')

class Scope {
  active () {
    return spanActivation.activeSpan()
  }

  activate (span, callback) {
    return spanActivation.runWithSpan(span, callback)
  }

  bind (fn, span) {
    return spanActivation.bindToSpan(fn, span)
  }
}

module.exports = Scope
