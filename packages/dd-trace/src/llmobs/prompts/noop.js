'use strict'

const log = require('../../log')
const { PromptAPIError } = require('./errors')
const { ManagedPrompt } = require('./prompt')

class NoopPrompts {
  #reason
  #warned = false

  /**
   * @param {{reason?: string}} options
   */
  constructor ({ reason } = {}) {
    this.#reason = reason
  }

  #error () {
    if (!this.#warned) {
      this.#warned = true
      log.warn('LLMObs prompt management is unavailable: %s', this.#reason)
    }
    return new PromptAPIError(this.#reason ?? '')
  }

  /**
   * @param {string} id
   * @param {import('../../../../../index').llmobs.GetPromptOptions} options
   * @returns {Promise<ManagedPrompt>}
   */
  get (id, options = {}) {
    if (options.fallback !== undefined) {
      this.#error()
      return Promise.resolve(ManagedPrompt.fromFallback(options.fallback, id))
    }
    return Promise.reject(this.#error())
  }

  create (options) { return Promise.reject(this.#error()) }
  createVersion (id, options) { return Promise.reject(this.#error()) }
  update (id, options) { return Promise.reject(this.#error()) }
  updateVersion (id, version, options) { return Promise.reject(this.#error()) }
  delete (id) { return Promise.reject(this.#error()) }
  list () { return Promise.reject(this.#error()) }
  listVersions (id) { return Promise.reject(this.#error()) }
  refresh (id, options) { return Promise.reject(this.#error()) }
  clearCache () {}
}

module.exports = { NoopPrompts }
