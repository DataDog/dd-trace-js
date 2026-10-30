'use strict'

const { channel } = require('dc-polyfill')

const { DatadogNodeServerProvider } = require('../../../../vendor/dist/@datadog/openfeature-node-server')
const log = require('../log')
const { debugChannel } = require('../log/channels')
const configurationSource = require('./configuration_source')
const { EXPOSURE_CHANNEL } = require('./constants/constants')
const DebugLoggingHook = require('./debug-logging-hook')
const EvalMetricsHook = require('./eval-metrics-hook')
const EvaluationTelemetryOptOutHook = require('./evaluation-telemetry-opt-out-hook')
const SpanEnrichmentHook = require('./span-enrichment-hook')
const FlagEvalEVPHook = require('./writers/flag-eval-evp-hook')

const RAW_EVALUATION_DATA_WARNING = 'Feature Flags: debug logging is enabled, so feature flag logs include raw ' +
  'evaluation data (targeting keys, evaluation context attributes, flag values, and default values) that may ' +
  'contain personal or sensitive information. Unset DD_TRACE_DEBUG when you no longer need it.'

/**
 * OpenFeature provider that integrates with Datadog's feature flagging system.
 * Extends DatadogNodeServerProvider to add tracer integration and configuration management.
 */
class FlaggingProvider extends DatadogNodeServerProvider {
  // Track this wrapper's logging lifecycle without reading the upstream provider's private state.
  #waitingForConfiguration = false

  /** @type {SpanEnrichmentHook | undefined} */
  #spanEnrichmentHook

  /** @type {FlagEvalEVPHook | undefined} */
  #flagEvalEVPHook

  /** @type {{ start: Function, stop: Function } | undefined} */
  #configurationSource

  /** @type {number} */
  #initializationTimeoutMs

  /**
   * @param {import('../tracer')} tracer - Datadog tracer instance
   * @param {import('../config/config-base')} config - Tracer configuration object
   */
  constructor (tracer, config) {
    super({
      exposureChannel: channel(EXPOSURE_CHANNEL),
      initializationTimeoutMs: config.featureFlags.DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS,
    })

    const enableOptOut =
      config.featureFlags.DD_FEATURE_FLAGS_EVALUATION_TELEMETRY_PER_SUBJECT_OPT_OUT_ENABLED === true
    /** @param {import('@openfeature/server-sdk').Hook} hook */
    const telemetryHook = hook => enableOptOut ? new EvaluationTelemetryOptOutHook(hook) : hook

    if (config.DD_METRICS_OTEL_ENABLED === true) {
      this.hooks.push(telemetryHook(new EvalMetricsHook(config)))
    } else {
      log.debug('Feature Flags: evaluation metrics disabled; set %s=true to enable', 'DD_METRICS_OTEL_ENABLED')
    }

    if (config.debug && debugChannel.hasSubscribers) {
      this.hooks.push(new DebugLoggingHook(() => this.getConfiguration()))
      log.warn(RAW_EVALUATION_DATA_WARNING)
    }

    if (config.featureFlags.DD_EXPERIMENTAL_FLAGGING_PROVIDER_SPAN_ENRICHMENT_ENABLED) {
      this.#spanEnrichmentHook = new SpanEnrichmentHook(tracer)
      // @ts-expect-error The upstream constructor always initializes its optional hooks property.
      this.hooks.push(telemetryHook(this.#spanEnrichmentHook))
      log.info('%s span enrichment enabled', this.constructor.name)
    } else {
      log.info('%s span enrichment disabled', this.constructor.name)
    }

    this.#initializationTimeoutMs = config.featureFlags.DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS
    log.debug('Feature Flags: %s created (configuration source %s, sdk env=%s, initialization timeout %dms)',
      this.constructor.name, config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE, config.env ?? 'unset',
      this.#initializationTimeoutMs)

    if (config.featureFlags?.DD_FLAGGING_EVALUATION_COUNTS_ENABLED !== false) {
      this.#flagEvalEVPHook = new FlagEvalEVPHook(config)
      this.hooks.push(telemetryHook(this.#flagEvalEVPHook))
    }

    this.#configurationSource = configurationSource.create(config, this.setConfiguration.bind(this))
    this.#configurationSource?.start()
  }

  /**
   * @param {import('@openfeature/core').EvaluationContext} [context]
   * @returns {Promise<void>}
   */
  initialize (context) {
    const hasConfiguration = this.getConfiguration() !== undefined

    this.#waitingForConfiguration = !hasConfiguration
    const promise = super.initialize(context)

    if (hasConfiguration) {
      this.#logInitialConfiguration()
    } else {
      log.debug('Feature Flags: waiting for provider initialization (timeout %dms)...', this.#initializationTimeoutMs)
    }

    return promise
  }

  /**
   * @param {Parameters<DatadogNodeServerProvider['setConfiguration']>[0]} configuration
   */
  setConfiguration (configuration) {
    const wasWaiting = this.#waitingForConfiguration
    // The upstream provider emits PROVIDER_READY for this transition without logging it.
    const recovering = !wasWaiting && configuration != null && this.getConfiguration() == null &&
      this.initController !== undefined && !this.initController.isInitializing()

    super.setConfiguration(configuration)
    // An empty update leaves upstream initialization pending until configuration arrives or it times out.
    if (configuration == null) return
    this.#waitingForConfiguration = false

    if (wasWaiting) {
      this.#logInitialConfiguration()
    } else if (recovering) {
      this.#logRecovery()
    }
  }

  /**
   * @param {unknown} error
   */
  setError (error) {
    const wasWaiting = this.#waitingForConfiguration
    super.setError(error)
    this.#waitingForConfiguration = false
    if (!wasWaiting) return

    try {
      // Avoid inflating telemetry volume for routine initialization timeouts.
      log.errorWithoutTelemetry(
        'Feature Flags: provider failed to initialize: %s',
        error instanceof Error ? error.message : String(error)
      )
    } catch { /* logging failure must not affect initialization */ }
  }

  #logInitialConfiguration () {
    try {
      log.debug('Feature Flags: initial configuration available')
    } catch { /* logging failure must not affect initialization */ }
  }

  #logRecovery () {
    try {
      log.debug('Feature Flags: configuration applied after the provider was not ready; provider is ready again')
    } catch { /* logging failure must not affect applying the configuration */ }
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
    this.#flagEvalEVPHook?.destroy()
    this.#flagEvalEVPHook = undefined
    log.debug('Feature Flags: provider closed')
  }
}

module.exports = FlaggingProvider
