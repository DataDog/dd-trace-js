'use strict'

class NoopAIGuard {
  /**
   * @param {import('../../../../index').aiguard.ClientOptions} [options]
   * @returns {NoopAIGuard}
   */
  createClient (options) {
    return this
  }

  evaluate (messages, opts) {
    return Promise.resolve({
      action: 'ALLOW',
      reason: 'AI Guard is not enabled',
      tags: [],
      tagProbabilities: {},
      sds: [],
      messages,
      redactionReplacements: [],
    })
  }
}

module.exports = NoopAIGuard
