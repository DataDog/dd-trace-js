'use strict'

// No-op Experiments used when LLM Observability is disabled or the API/APP keys
// are not configured. Every operation throws a clear, actionable error rather
// than silently doing nothing, so misconfiguration surfaces immediately.
class NoopExperiments {
  #reason

  constructor (reason) {
    this.#reason = reason || 'LLMObs experiments are not available'
  }

  #unavailable () {
    return new Error(`LLMObs experiments unavailable: ${this.#reason}`)
  }

  createDataset () {
    throw this.#unavailable()
  }

  pullDataset () {
    return Promise.reject(this.#unavailable())
  }

  experiment () {
    throw this.#unavailable()
  }
}

module.exports = NoopExperiments
