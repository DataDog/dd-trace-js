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
    const startedAt = Date.now()
    const hadConfiguration = this.getConfiguration() !== undefined

    const promise = super.initialize(context)

    // `DatadogNodeServerProvider#initialize` starts a timer that is never unref'd, which would
    // otherwise keep an idle process (a short script, a serverless handler) alive for up to
    // `initializationTimeoutMs` while waiting for configuration to arrive.
    // TODO: remove once `@datadog/openfeature-node-server` unrefs this timer itself.
    this.initController?.timeoutId?.unref?.()

    if (hadConfiguration) {
      log.debug('Feature Flags: configuration already applied; provider initialization does not need to wait')
    } else {
      log.debug('Feature Flags: waiting for provider initialization (timeout %dms)...', this.#initializationTimeoutMs)
    }

    // Only observes the outcome for logging; `promise` itself is returned unmodified below.
    // Guarded so a logger failure can never leave the derived promise unhandled.
    promise.then(
      () => {
        try {
          log.debug('Feature Flags: provider initialized successfully after %dms', Date.now() - startedAt)
        } catch { /* logging failure must not crash the process */ }
      },
      (error) => {
        try {
          // errorWithoutTelemetry avoids inflating telemetry volume for every routine init timeout.
          log.errorWithoutTelemetry(
            'Feature Flags: provider failed to initialize: %s',
            error instanceof Error ? error.message : String(error)
          )
        } catch { /* logging failure must not crash the process */ }
      }
    )

    return promise
  }

  /**
   * @param {import('@datadog/openfeature-node-server').UniversalFlagConfigurationV1 | undefined} configuration
   */
  setConfiguration (configuration) {
    // The upstream provider emits PROVIDER_READY for this transition without logging it.
    const recovering = configuration !== undefined && this.getConfiguration() === undefined &&
      this.initController !== undefined && !this.initController.isInitializing()

    super.setConfiguration(configuration)

    if (recovering) {
      log.debug('Feature Flags: configuration applied after the provider was not ready; provider is ready again')
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
    this.#flagEvalEVPHook?.destroy()
    this.#flagEvalEVPHook = undefined
    log.debug('Feature Flags: provider closed')
  }
}

module.exports = FlaggingProvider
