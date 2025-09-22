'use strict'

class NoopAIGuard {
  constructor (noopTracer) {
    this._tracer = noopTracer
  }

  evaluate (messages, opts) {
    return {
      action: 'ALLOW',
      reason: 'AI Guard is not enabled'
    }
  }
}

module.exports = NoopAIGuard
