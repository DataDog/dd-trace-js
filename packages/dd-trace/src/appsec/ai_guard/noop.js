'use strict'

class NoopAIGuard {
  constructor (noopTracer) {
    this._tracer = noopTracer
  }

  evaluate (messages, opts) {
    return new Promise((resolve, reject) => {
      reject(new Error('AI Guard is not enabled'))
    })
  }
}

module.exports = NoopAIGuard
