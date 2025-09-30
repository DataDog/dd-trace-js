'use strict'

class NoopAIGuard {
  constructor (noopTracer) {
    this._tracer = noopTracer
  }

  evaluate (messages, opts) {
    return Promise.resolve({ action: 'ALLOW', reason: 'AI Guard is not enabled' })
  }
}

module.exports = NoopAIGuard
