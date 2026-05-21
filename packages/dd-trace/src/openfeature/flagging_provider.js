'use strict'

const { DatadogNodeServerProvider } = require('@datadog/openfeature-node-server')
const { channel } = require('dc-polyfill')
const log = require('../log')
const { EXPOSURE_CHANNEL } = require('./constants/constants')
const EvalMetricsHook = require('./eval-metrics-hook')

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

    this.hooks.push(new EvalMetricsHook(config))

    log.debug('%s created with timeout: %dms', this.constructor.name,
      config.experimental.flaggingProvider.initializationTimeoutMs)
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
    this._ffeConfig = ufc
    if (typeof this.setConfiguration === 'function') {
      this.setConfiguration(ufc)
    }
    log.debug('%s provider configuration updated', this.constructor.name)
  }

  async resolveBooleanEvaluation (flagKey, defaultValue, context, logger) {
    const result = await super.resolveBooleanEvaluation(flagKey, defaultValue, context, logger)
    return this._normalizeResolution(flagKey, defaultValue, result)
  }

  async resolveStringEvaluation (flagKey, defaultValue, context, logger) {
    const result = await super.resolveStringEvaluation(flagKey, defaultValue, context, logger)
    return this._normalizeResolution(flagKey, defaultValue, result)
  }

  async resolveNumberEvaluation (flagKey, defaultValue, context, logger) {
    const result = await super.resolveNumberEvaluation(flagKey, defaultValue, context, logger)
    return this._normalizeResolution(flagKey, defaultValue, result)
  }

  async resolveObjectEvaluation (flagKey, defaultValue, context, logger) {
    const result = await super.resolveObjectEvaluation(flagKey, defaultValue, context, logger)
    return this._normalizeResolution(flagKey, defaultValue, result)
  }

  _normalizeResolution (flagKey, defaultValue, result) {
    if (result?.errorCode === 'FLAG_NOT_FOUND') {
      const { errorCode, ...withoutError } = result
      return { ...withoutError, value: defaultValue, reason: 'DEFAULT' }
    }

    if (result?.reason !== 'TARGETING_MATCH') {
      return result
    }

    const allocationKey = result.flagMetadata?.allocationKey
    const allocation = this._ffeConfig?.flags?.[flagKey]?.allocations?.find(item => item.key === allocationKey)
    if (!allocation) {
      return result
    }

    if (allocation.rules?.length) {
      return result
    }

    const flag = this._ffeConfig.flags[flagKey]
    const selectedSplit = allocation.splits?.find(split => {
      const variant = flag.variations?.[split.variationKey]
      return variant?.key === result.variant || split.variationKey === result.variant
    })
    const reason = selectedSplit?.shards?.length ? 'SPLIT' : 'STATIC'
    return { ...result, reason }
  }
}

module.exports = FlaggingProvider
