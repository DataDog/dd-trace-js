'use strict'

const { NOOP_REASON } = require('./constants/constants')

/**
 * No-op implementation of OpenFeature provider that always returns default values.
 * Used when the OpenFeature provider is not initialized or disabled.
 * https://openfeature.dev/docs/reference/concepts/provider/
 */
class NoopFlaggingProvider {
  /**
   * @param {Object} [noopTracer] - Optional noop tracer instance
   */
  constructor (noopTracer) {
    this._tracer = noopTracer
    this._config = {}
    this.metadata = { name: 'NoopFlaggingProvider' }
    this.status = 'NOT_READY'
    this.runsOn = 'server'
  }

  /**
   * @param {string} flagKey - Flag key
   * @param {boolean} defaultValue - Default value to return
   * @param {Object} context - Evaluation context
   * @param {Object} logger - Logger instance
   * @returns {Promise<{value: boolean, reason: string}>} Resolution details
   */
  resolveBooleanEvaluation (flagKey, defaultValue, context, logger) {
    return Promise.resolve({
      value: defaultValue,
      reason: NOOP_REASON
    })
  }

  /**
   * @param {string} flagKey - Flag key
   * @param {string} defaultValue - Default value to return
   * @param {Object} context - Evaluation context
   * @param {Object} logger - Logger instance
   * @returns {Promise<{value: string, reason: string}>} Resolution details
   */
  resolveStringEvaluation (flagKey, defaultValue, context, logger) {
    return Promise.resolve({
      value: defaultValue,
      reason: NOOP_REASON
    })
  }

  /**
   * @param {string} flagKey - Flag key
   * @param {number} defaultValue - Default value to return
   * @param {Object} context - Evaluation context
   * @param {Object} logger - Logger instance
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
   * @param {Object} defaultValue - Default value to return
   * @param {Object} context - Evaluation context
   * @param {Object} logger - Logger instance
   * @returns {Promise<{value: Object, reason: string}>} Resolution details
   */
  resolveObjectEvaluation (flagKey, defaultValue, context, logger) {
    return Promise.resolve({
      value: defaultValue,
      reason: NOOP_REASON
    })
  }

  /**
   * @returns {Object} Current configuration
   */
  getConfiguration () {
    return this._config
  }

  /**
   * @param {Object} config - Configuration to set
   */
  setConfiguration (config) {
    this._config = config
  }

  /**
   * @internal
   * @param {Object} ufc - Universal Flag Configuration object
   */
  _setConfiguration (ufc) {
    this.setConfiguration(ufc)
  }
}

module.exports = NoopFlaggingProvider
