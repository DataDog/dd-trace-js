'use strict'

class NoopAIGuard {
  evaluate (messages, opts) {
    return Promise.resolve({ action: 'ALLOW', reason: 'AI Guard is not enabled' })
  }
}

module.exports = NoopAIGuard
