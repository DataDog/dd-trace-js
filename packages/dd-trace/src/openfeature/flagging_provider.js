'use strict'

const { channel } = require('dc-polyfill')
const log = require('../log')
const configurationSource = require('./configuration_source')
const { EXPOSURE_CHANNEL } = require('./constants/constants')
const EvalMetricsHook = require('./eval-metrics-hook')
const SpanEnrichmentHook = require('./span-enrichment-hook')

const { DatadogNodeServerProvider } = require('./require-provider')

/**
 * OpenFeature provider that integrates with Datadog's feature flagging system.
 * Extends DatadogNodeServerProvider to add tracer integration and configuration management.
 */
class FlaggingProvider extends DatadogNodeServerProvider {
  /** @type {SpanEnrichmentHook | undefined} */
  #spanEnrichmentHook

  /** @type {{ start: Function, stop: Function } | undefined} */
  #configurationSource

  /** @type {import('@datadog/openfeature-node-server').UniversalFlagConfigurationV1 | undefined} */
  #ffeConfig

  /**
   * @param {import('../tracer')} tracer - Datadog tracer instance
   * @param {import('../config/config-base')} config - Tracer configuration object
   */
  constructor (tracer, config) {
    super({
      exposureChannel: channel(EXPOSURE_CHANNEL),
      initializationTimeoutMs: config.experimental.flaggingProvider.initializationTimeoutMs,
    })

    this.hooks.push(new EvalMetricsHook(config))

    if (config.experimental.flaggingProvider.spanEnrichment?.enabled) {
      this.#spanEnrichmentHook = new SpanEnrichmentHook(tracer)
      // @ts-expect-error The upstream constructor always initializes its optional hooks property.
      this.hooks.push(this.#spanEnrichmentHook)
      log.info('%s span enrichment enabled', this.constructor.name)
    } else {
      log.info('%s span enrichment disabled', this.constructor.name)
    }

    log.debug('%s created with timeout: %dms', this.constructor.name,
      config.experimental.flaggingProvider.initializationTimeoutMs)

    this.#configurationSource = configurationSource.create(config, this.setConfiguration.bind(this))
    this.#configurationSource?.start()
  }

  /**
   * Stores the current configuration and updates the base provider.
   *
   * @param {import('@datadog/openfeature-node-server').UniversalFlagConfigurationV1 | undefined} configuration
   * @returns {void}
   */
  setConfiguration (configuration) {
    this.#ffeConfig = configuration
    super.setConfiguration(configuration)
  }

  /**
   * Resolves a boolean flag and normalizes its canonical result.
   *
   * @param {string} flagKey
   * @param {boolean} defaultValue
   * @param {import('@openfeature/server-sdk').EvaluationContext} context
   * @param {import('@openfeature/server-sdk').Logger} logger
   * @returns {Promise<import('@openfeature/server-sdk').ResolutionDetails<boolean>>}
   */
  resolveBooleanEvaluation (flagKey, defaultValue, context, logger) {
    const parseError = this.#variantTypeMismatchResolution(flagKey, defaultValue, 'boolean')
    if (parseError) return Promise.resolve(parseError)

    return super.resolveBooleanEvaluation(flagKey, defaultValue, context, logger)
      .then(result => this.#normalizeResolution(flagKey, result))
  }

  /**
   * Resolves a string flag and normalizes its canonical result.
   *
   * @param {string} flagKey
   * @param {string} defaultValue
   * @param {import('@openfeature/server-sdk').EvaluationContext} context
   * @param {import('@openfeature/server-sdk').Logger} logger
   * @returns {Promise<import('@openfeature/server-sdk').ResolutionDetails<string>>}
   */
  resolveStringEvaluation (flagKey, defaultValue, context, logger) {
    const parseError = this.#variantTypeMismatchResolution(flagKey, defaultValue, 'string')
    if (parseError) return Promise.resolve(parseError)

    return super.resolveStringEvaluation(flagKey, defaultValue, context, logger)
      .then(result => this.#normalizeResolution(flagKey, result))
  }

  /**
   * Resolves a number flag and normalizes its canonical result.
   *
   * @param {string} flagKey
   * @param {number} defaultValue
   * @param {import('@openfeature/server-sdk').EvaluationContext} context
   * @param {import('@openfeature/server-sdk').Logger} logger
   * @returns {Promise<import('@openfeature/server-sdk').ResolutionDetails<number>>}
   */
  resolveNumberEvaluation (flagKey, defaultValue, context, logger) {
    const parseError = this.#variantTypeMismatchResolution(flagKey, defaultValue, 'number')
    if (parseError) return Promise.resolve(parseError)

    return super.resolveNumberEvaluation(flagKey, defaultValue, context, logger)
      .then(result => this.#normalizeResolution(flagKey, result))
  }

  /**
   * Resolves an object flag and normalizes its canonical result.
   *
   * @template {import('@openfeature/server-sdk').JsonValue} T
   * @param {string} flagKey
   * @param {T} defaultValue
   * @param {import('@openfeature/server-sdk').EvaluationContext} context
   * @param {import('@openfeature/server-sdk').Logger} logger
   * @returns {Promise<import('@openfeature/server-sdk').ResolutionDetails<T>>}
   */
  resolveObjectEvaluation (flagKey, defaultValue, context, logger) {
    const parseError = this.#variantTypeMismatchResolution(flagKey, defaultValue, 'object')
    if (parseError) return Promise.resolve(parseError)

    return super.resolveObjectEvaluation(flagKey, defaultValue, context, logger)
      .then(result => this.#normalizeResolution(flagKey, result))
  }

  /**
   * Converts provider results to the canonical FFE reason contract.
   *
   * @template {import('@openfeature/server-sdk').FlagValue} T
   * @param {string} flagKey
   * @param {import('@openfeature/server-sdk').ResolutionDetails<T>} result
   * @returns {import('@openfeature/server-sdk').ResolutionDetails<T>}
   */
  #normalizeResolution (flagKey, result) {
    if (result?.reason !== 'TARGETING_MATCH' && result?.reason !== 'DEFAULT') {
      return result
    }

    const allocations = this.#ffeConfig?.flags?.[flagKey]?.allocations
    if (!Array.isArray(allocations)) {
      return result
    }

    const allocation = allocations.find(item => item.key === result.flagMetadata?.allocationKey)
    if (!allocation || allocation.rules?.length || !Array.isArray(allocation.splits)) {
      return result
    }

    const flag = this.#ffeConfig.flags[flagKey]
    const selectedSplit = allocation.splits.find(split => {
      const variant = flag.variations?.[split.variationKey]
      return variant?.key === result.variant || split.variationKey === result.variant
    })
    if (!selectedSplit) {
      return result
    }

    const hasTimeBounds = allocation.startAt !== undefined || allocation.endAt !== undefined
    if (hasTimeBounds && allocation.splits.length === 1 && !selectedSplit.shards?.length) {
      return { ...result, reason: 'DEFAULT' }
    }

    const reason = selectedSplit?.shards?.length ? 'SPLIT' : 'STATIC'
    return { ...result, reason }
  }

  /**
   * Returns a parse error when the requested type matches a flag whose variant
   * values violate its declared variation type.
   *
   * @template {import('@openfeature/server-sdk').FlagValue} T
   * @param {string} flagKey
   * @param {T} defaultValue
   * @param {'boolean'|'string'|'number'|'object'} requestedType
   * @returns {import('@openfeature/server-sdk').ResolutionDetails<T> | undefined}
   */
  #variantTypeMismatchResolution (flagKey, defaultValue, requestedType) {
    const flag = this.#ffeConfig?.flags?.[flagKey]
    if (!flag || flag.enabled === false || !this.#requestedTypeMatches(flag.variationType, requestedType)) {
      return
    }
    if (!this.#hasVariantTypeMismatch(flagKey)) {
      return
    }

    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR',
      errorMessage: 'Variant value does not match the declared variation type',
    }
  }

  /**
   * @param {string} variationType
   * @param {'boolean'|'string'|'number'|'object'} requestedType
   * @returns {boolean}
   */
  #requestedTypeMatches (variationType, requestedType) {
    if (typeof variationType !== 'string') {
      return false
    }
    if (requestedType === 'number') {
      return variationType === 'INTEGER' || variationType === 'NUMERIC'
    }
    if (requestedType === 'object') {
      return variationType === 'JSON'
    }
    return variationType.toLowerCase() === requestedType
  }

  /**
   * Returns whether any variant value violates its flag's declared variation type.
   *
   * @param {string} flagKey
   * @returns {boolean}
   */
  #hasVariantTypeMismatch (flagKey) {
    const flag = this.#ffeConfig?.flags?.[flagKey]
    if (!flag?.variations || typeof flag.variations !== 'object') {
      return false
    }

    return Object.values(flag.variations).some(variation => {
      if (!variation || typeof variation !== 'object' || !('value' in variation)) {
        return false
      }
      return !this.#valueMatchesVariationType(flag.variationType, variation.value)
    })
  }

  /**
   * @param {string} variationType
   * @param {unknown} value
   * @returns {boolean}
   */
  #valueMatchesVariationType (variationType, value) {
    switch (variationType) {
      case 'BOOLEAN':
        return typeof value === 'boolean'
      case 'STRING':
        return typeof value === 'string'
      case 'INTEGER':
        return Number.isInteger(value)
      case 'NUMERIC':
        return typeof value === 'number' && Number.isFinite(value)
      case 'JSON':
        return value !== undefined
      default:
        return true
    }
  }

  /**
   * Called when the provider is shut down.
   * Cleans up resources including channel subscriptions.
   */
  onClose () {
    this.#configurationSource?.stop()
    this.#configurationSource = undefined
    this.#spanEnrichmentHook?.destroy()
    this.#spanEnrichmentHook = undefined
  }
}

module.exports = FlaggingProvider
