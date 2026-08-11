'use strict'

const { channel } = require('dc-polyfill')
const log = require('../log')
const configurationSource = require('./configuration_source')
const { EXPOSURE_CHANNEL } = require('./constants/constants')
const EvalMetricsHook = require('./eval-metrics-hook')
const SpanEnrichmentHook = require('./span-enrichment-hook')
const { addSemverContext, sanitizeConfiguration } = require('./ffe-evaluator')

const { DatadogNodeServerProvider } = require('./require-provider')

/** @type {import('@openfeature/server-sdk').ErrorCode} */
// @ts-expect-error OpenFeature publishes ErrorCode as a string enum, but providers return its wire value.
const PARSE_ERROR = 'PARSE_ERROR'

/**
 * OpenFeature provider that integrates with Datadog's feature flagging system.
 * Extends DatadogNodeServerProvider to add tracer integration and configuration management.
 */
class FlaggingProvider extends DatadogNodeServerProvider {
  /** @type {SpanEnrichmentHook | undefined} */
  #spanEnrichmentHook

  /** @type {{ start: Function, stop: Function } | undefined} */
  #configurationSource

  /** @type {ReturnType<sanitizeConfiguration>} */
  #ffeState = sanitizeConfiguration()

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
    const state = sanitizeConfiguration(configuration)
    // @ts-expect-error The upstream implementation accepts undefined to clear its current configuration.
    super.setConfiguration(state.configuration)
    this.#ffeState = state
  }

  /**
   * Returns the exact source configuration supplied to the provider.
   *
   * @returns {import('@datadog/openfeature-node-server').UniversalFlagConfigurationV1 | undefined}
   */
  getConfiguration () {
    return this.#ffeState.sourceConfiguration
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
    const local = this.#rejectedFlagResolution(flagKey, defaultValue)
    if (local) return Promise.resolve(local)
    return super.resolveBooleanEvaluation(flagKey, defaultValue, this.#addSemverContext(flagKey, context), logger)
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
    const local = this.#rejectedFlagResolution(flagKey, defaultValue)
    if (local) return Promise.resolve(local)
    return super.resolveStringEvaluation(flagKey, defaultValue, this.#addSemverContext(flagKey, context), logger)
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
    const local = this.#rejectedFlagResolution(flagKey, defaultValue)
    if (local) return Promise.resolve(local)
    return super.resolveNumberEvaluation(flagKey, defaultValue, this.#addSemverContext(flagKey, context), logger)
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
    const local = this.#rejectedFlagResolution(flagKey, defaultValue)
    if (local) return Promise.resolve(local)
    return super.resolveObjectEvaluation(flagKey, defaultValue, this.#addSemverContext(flagKey, context), logger)
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

    const flag = this.#ffeState.configuration?.flags?.[flagKey]
    const allocations = flag?.allocations
    if (!flag || !Array.isArray(allocations)) {
      return result
    }

    const allocation = allocations.find(item => item.key === result.flagMetadata?.allocationKey)
    if (!allocation || allocation.rules?.length || !Array.isArray(allocation.splits)) {
      return result
    }

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
   * Returns the canonical parse error for a flag rejected during ingestion.
   *
   * @template {import('@openfeature/server-sdk').FlagValue} T
   * @param {string} flagKey
   * @param {T} defaultValue
   * @returns {import('@openfeature/server-sdk').ResolutionDetails<T> | false}
   */
  #rejectedFlagResolution (flagKey, defaultValue) {
    return this.#ffeState.rejected.has(flagKey) &&
      { value: defaultValue, reason: 'ERROR', errorCode: PARSE_ERROR }
  }

  /**
   * Adds synthetic attributes consumed by transformed SemVer rules.
   *
   * @param {string} flagKey
   * @param {import('@openfeature/server-sdk').EvaluationContext} context
   * @returns {import('@openfeature/server-sdk').EvaluationContext}
   */
  #addSemverContext (flagKey, context) {
    return addSemverContext(this.#ffeState.semverConditions.get(flagKey), context)
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
