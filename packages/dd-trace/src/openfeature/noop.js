'use strict'

const { NOOP_REASON } = require('./constants/constants')

/**
 * @template T
 * @param {T} defaultValue
 * @returns {Promise<{value: T, reason: string}>}
 */
function resolveDefault (defaultValue) {
  return Promise.resolve({
    value: defaultValue,
    reason: NOOP_REASON,
  })
}

/**
 * No-op implementation of OpenFeature provider that always returns default values.
 * Used when the OpenFeature provider is not initialized or disabled.
 * https://openfeature.dev/docs/reference/concepts/provider/
 */
class NoopFlaggingProvider {
  constructor () {
    this.metadata = { name: 'NoopFlaggingProvider' }
    this.status = 'NOT_READY'
    this.runsOn = 'server'
  }

  /**
   * @template T
   * @param {string} flagKey
   * @param {T} defaultValue
   * @param {object} context
   * @param {object} logger
   * @returns {Promise<{value: T, reason: string}>}
   */
  resolveBooleanEvaluation (flagKey, defaultValue, context, logger) {
    return resolveDefault(defaultValue)
  }

  /**
   * @template T
   * @param {string} flagKey
   * @param {T} defaultValue
   * @param {object} context
   * @param {object} logger
   * @returns {Promise<{value: T, reason: string}>}
   */
  resolveStringEvaluation (flagKey, defaultValue, context, logger) {
    return resolveDefault(defaultValue)
  }

  /**
   * @template T
   * @param {string} flagKey
   * @param {T} defaultValue
   * @param {object} context
   * @param {object} logger
   * @returns {Promise<{value: T, reason: string}>}
   */
  resolveNumberEvaluation (flagKey, defaultValue, context, logger) {
    return resolveDefault(defaultValue)
  }

  /**
   * @template T
   * @param {string} flagKey
   * @param {T} defaultValue
   * @param {object} context
   * @param {object} logger
   * @returns {Promise<{value: T, reason: string}>}
   */
  resolveObjectEvaluation (flagKey, defaultValue, context, logger) {
    return resolveDefault(defaultValue)
  }
}

module.exports = NoopFlaggingProvider
