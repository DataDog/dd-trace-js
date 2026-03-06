'use strict'

const { NOOP_REASON } = require('./constants/constants')

/**
 * No-op implementation of OpenFeature provider that always returns default values.
 * Used when the OpenFeature provider is not initialized or disabled.
 * https://openfeature.dev/docs/reference/concepts/provider/
 */
class NoopFlaggingProvider {
  #config

  /**
   * @param {object} [noopTracer] - Optional noop tracer instance
   */
  constructor (noopTracer) {
    this._tracer = noopTracer
    this.#config = {}
    this.metadata = { name: 'NoopFlaggingProvider' }
    this.status = 'NOT_READY'
    this.runsOn = 'server'
  }

  /**
   * @param {string} flagKey - Flag key
   * @param {boolean} defaultValue - Default value to return
   * @param {object} context - Evaluation context
   * @param {object} logger - Logger instance
   * @returns {Promise<{value: boolean, reason: string}>} Resolution details
   */
  resolveBooleanEvaluation (flagKey, defaultValue, context, logger) {
    return Promise.resolve({
      value: defaultValue,
      reason: NOOP_REASON,
    })
  }

  /**
   * @param {string} flagKey - Flag key
   * @param {string} defaultValue - Default value to return
   * @param {object} context - Evaluation context
   * @param {object} logger - Logger instance
   * @returns {Promise<{value: string, reason: string}>} Resolution details
   */
  resolveStringEvaluation (flagKey, defaultValue, context, logger) {
    return Promise.resolve({
      value: defaultValue,
      reason: NOOP_REASON,
    })
  }

  /**
   * @param {string} flagKey - Flag key
   * @param {number} defaultValue - Default value to return
   * @param {object} context - Evaluation context
   * @param {object} logger - Logger instance
   * @returns {Promise<{value: number, reason: string}>} Resolution details
   */
  resolveNumberEvaluation (flagKey, defaultValue, context, logger) {
    return Promise.resolve({
      value: defaultValue,
      reason: NOOP_REASON,
    })
  }

  /**
   * @param {string} flagKey - Flag key
   * @param {object} defaultValue - Default value to return
   * @param {object} context - Evaluation context
   * @param {object} logger - Logger instance
   * @returns {Promise<{value: object, reason: string}>} Resolution details
   */
  resolveObjectEvaluation (flagKey, defaultValue, context, logger) {
    return Promise.resolve({
      value: defaultValue,
      reason: NOOP_REASON,
    })
  }

  // Exposed for test access
  get _config () { return this.#config }

  /**
   * @returns {object} Current configuration
   */
  getConfiguration () {
    return this.#config
  }

  /**
   * @param {object} config - Configuration to set
   */
  setConfiguration (config) {
    this.#config = config
  }

  /**
   * @internal
   * @param {object} ufc - Universal Flag Configuration object
   */
  _setConfiguration (ufc) {
    this.setConfiguration(ufc)
  }
}

module.exports = NoopFlaggingProvider
