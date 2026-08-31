'use strict'

class AIGuardAbortError extends Error {
  /**
   * @param {string|undefined} reason
   * @param {Array<unknown>} tags
   * @param {Record<string, unknown>} tagProbabilities
   * @param {Array<unknown>} sds
   */
  constructor (reason, tags, tagProbabilities, sds) {
    super(reason)
    this.name = 'AIGuardAbortError'
    this.reason = reason
    this.tags = tags
    this.tagProbabilities = tagProbabilities
    this.sds = sds || []
  }
}

class AIGuardClientError extends Error {
  /**
   * @param {string} message
   * @param {{ telemetryType: string, errors?: Array<unknown>, cause?: Error }} opts
   */
  constructor (message, opts) {
    super(message)
    this.name = 'AIGuardClientError'
    this.telemetryType = opts.telemetryType
    if (opts.errors) {
      this.errors = opts.errors
    }
    if (opts.cause) {
      this.cause = opts.cause
    }
  }
}

module.exports = {
  AIGuardAbortError,
  AIGuardClientError,
}
