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

  /** @type {Map<string, string>} */
  #variantTypeMismatches = new Map()

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
   * Updates the base provider and caches malformed variant types.
   *
   * @param {import('@datadog/openfeature-node-server').UniversalFlagConfigurationV1 | undefined} configuration
   * @returns {void}
   */
  setConfiguration (configuration) {
    this.#variantTypeMismatches = this.#findVariantTypeMismatches(configuration)
    super.setConfiguration(configuration)
  }

  /**
   * Resolves a boolean flag.
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
  }

  /**
   * Resolves a string flag.
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
  }

  /**
   * Resolves a number flag.
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
  }

  /**
   * Resolves an object flag.
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
    const variationType = this.#variantTypeMismatches.get(flagKey)
    if (!variationType || !this.#requestedTypeMatches(variationType, requestedType)) {
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
   * Finds flags with variant values that violate their declared variation type.
   *
   * @param {import('@datadog/openfeature-node-server').UniversalFlagConfigurationV1 | undefined} configuration
   * @returns {Map<string, string>}
   */
  #findVariantTypeMismatches (configuration) {
    const mismatches = new Map()
    if (!configuration?.flags || typeof configuration.flags !== 'object') {
      return mismatches
    }

    for (const [flagKey, flag] of Object.entries(configuration.flags)) {
      if (!flag || flag.enabled === false || !flag.variations || typeof flag.variations !== 'object') {
        continue
      }

      for (const variation of Object.values(flag.variations)) {
        if (!variation || typeof variation !== 'object' || !('value' in variation)) {
          continue
        }
        if (!this.#valueMatchesVariationType(flag.variationType, variation.value)) {
          mismatches.set(flagKey, flag.variationType)
          break
        }
      }
    }

    return mismatches
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
