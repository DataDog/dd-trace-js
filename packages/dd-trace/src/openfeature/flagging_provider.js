'use strict'

const { DatadogNodeServerProvider } = require('@datadog/openfeature-node-server')
const { channel } = require('dc-polyfill')
const log = require('../log')
const { EXPOSURE_CHANNEL } = require('./constants/constants')
const { tagSpansForEvaluation } = require('./span_tagger')

/**
 * OpenFeature provider that integrates with Datadog's feature flagging system.
 * Extends DatadogNodeServerProvider to add tracer integration and configuration management.
 */
class FlaggingProvider extends DatadogNodeServerProvider {
  /**
   * @param {import('../tracer')} tracer - Datadog tracer instance
   * @param {import('../config')} config - Tracer configuration object
   */
  constructor (tracer, config) {
    // Call parent constructor with required options and timeout
    super({
      exposureChannel: channel(EXPOSURE_CHANNEL),
      initializationTimeoutMs: config.experimental.flaggingProvider.initializationTimeoutMs,
    })

    this._tracer = tracer
    this._config = config

    log.debug('%s created with timeout: %dms', this.constructor.name,
      config.experimental.flaggingProvider.initializationTimeoutMs)
  }

  /**
   * Tags the active and root spans with feature flag evaluation metadata.
   *
   * @param {string} flagKey - The feature flag key
   * @param {import('@openfeature/core').EvaluationContext} context - The evaluation context
   * @param {import('@openfeature/core').ResolutionDetails<
   *   boolean | string | number | import('@openfeature/core').JsonValue
   * >} result - The evaluation result
   * @returns {import('@openfeature/core').ResolutionDetails<
   *   boolean | string | number | import('@openfeature/core').JsonValue
   * >} The evaluation result (passthrough)
   */
  _tagSpans (flagKey, context, result) {
    tagSpansForEvaluation(this._tracer, {
      flagKey,
      variantKey: result.variant ?? String(result.value),
      maxFlagTags: this._config.experimental.flaggingProvider.maxFlagTags,
    })

    return result
  }

  /**
   * @param {string} flagKey
   * @param {boolean} defaultValue
   * @param {import('@openfeature/core').EvaluationContext} context
   * @param {import('@openfeature/core').Logger} logger
   * @returns {Promise<import('@openfeature/core').ResolutionDetails<boolean>>}
   */
  resolveBooleanEvaluation (flagKey, defaultValue, context, logger) {
    return super.resolveBooleanEvaluation(flagKey, defaultValue, context, logger)
      .then(result => this._tagSpans(flagKey, context, result))
  }

  /**
   * @param {string} flagKey
   * @param {string} defaultValue
   * @param {import('@openfeature/core').EvaluationContext} context
   * @param {import('@openfeature/core').Logger} logger
   * @returns {Promise<import('@openfeature/core').ResolutionDetails<string>>}
   */
  resolveStringEvaluation (flagKey, defaultValue, context, logger) {
    return super.resolveStringEvaluation(flagKey, defaultValue, context, logger)
      .then(result => this._tagSpans(flagKey, context, result))
  }

  /**
   * @param {string} flagKey
   * @param {number} defaultValue
   * @param {import('@openfeature/core').EvaluationContext} context
   * @param {import('@openfeature/core').Logger} logger
   * @returns {Promise<import('@openfeature/core').ResolutionDetails<number>>}
   */
  resolveNumberEvaluation (flagKey, defaultValue, context, logger) {
    return super.resolveNumberEvaluation(flagKey, defaultValue, context, logger)
      .then(result => this._tagSpans(flagKey, context, result))
  }

  /**
   * @param {string} flagKey
   * @param {import('@openfeature/core').JsonValue} defaultValue
   * @param {import('@openfeature/core').EvaluationContext} context
   * @param {import('@openfeature/core').Logger} logger
   * @returns {Promise<import('@openfeature/core').ResolutionDetails<import('@openfeature/core').JsonValue>>}
   */
  resolveObjectEvaluation (flagKey, defaultValue, context, logger) {
    return super.resolveObjectEvaluation(flagKey, defaultValue, context, logger)
      .then(result => this._tagSpans(flagKey, context, result))
  }

  /**
   * Internal method to update flag configuration from Remote Config.
   * This method is called automatically when Remote Config delivers UFC updates.
   *
   * @internal
   * @param {import('@datadog/openfeature-node-server').UniversalFlagConfigurationV1} ufc
   * - Universal Flag Configuration object
   */
  _setConfiguration (ufc) {
    if (typeof this.setConfiguration === 'function') {
      this.setConfiguration(ufc)
    }
    log.debug('%s provider configuration updated', this.constructor.name)
  }
}

module.exports = FlaggingProvider
