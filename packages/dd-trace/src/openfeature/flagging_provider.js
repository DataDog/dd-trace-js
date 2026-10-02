'use strict'

const { channel } = require('dc-polyfill')

const { DatadogNodeServerProvider } = require('../../../../vendor/dist/@datadog/openfeature-node-server')
const log = require('../log')
const { debugChannel } = require('../log/channels')
const configurationSource = require('./configuration_source')
const { EXPOSURE_CHANNEL } = require('./constants/constants')
const DebugLoggingHook = require('./debug-logging-hook')
const EvalMetricsHook = require('./eval-metrics-hook')
const SpanEnrichmentHook = require('./span-enrichment-hook')
const FlagEvalEVPHook = require('./writers/flag-eval-evp-hook')

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

  /**
   * @param {import('../tracer')} tracer - Datadog tracer instance
   * @param {import('../config/config-base')} config - Tracer configuration object
   */
  constructor (tracer, config) {
    super({
      exposureChannel: channel(EXPOSURE_CHANNEL),
      initializationTimeoutMs: config.featureFlags.DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS,
    })

    if (config.DD_METRICS_OTEL_ENABLED === true) {
      this.hooks.push(new EvalMetricsHook(config))
    } else {
      log.debug('Feature Flags: evaluation metrics disabled; set %s=true to enable', 'DD_METRICS_OTEL_ENABLED')
    }

    if (config.debug && debugChannel.hasSubscribers) {
      this.hooks.push(new DebugLoggingHook())
    }

    if (config.featureFlags.DD_EXPERIMENTAL_FLAGGING_PROVIDER_SPAN_ENRICHMENT_ENABLED) {
      this.#spanEnrichmentHook = new SpanEnrichmentHook(tracer)
      // @ts-expect-error The upstream constructor always initializes its optional hooks property.
      this.hooks.push(this.#spanEnrichmentHook)
      log.info('%s span enrichment enabled', this.constructor.name)
    } else {
      log.info('%s span enrichment disabled', this.constructor.name)
    }

    log.debug('%s created with timeout: %dms', this.constructor.name,
      config.featureFlags.DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS)

    if (config.featureFlags?.DD_FLAGGING_EVALUATION_COUNTS_ENABLED !== false) {
      this.#flagEvalEVPHook = new FlagEvalEVPHook(config)
      this.hooks.push(this.#flagEvalEVPHook)
    }

    this.#configurationSource = configurationSource.create(config, this.setConfiguration.bind(this))
    this.#configurationSource?.start()
  }

  /**
   * @param {import('@openfeature/core').EvaluationContext} [context]
   * @returns {Promise<void>}
   */
  initialize (context) {
    log.debug('Feature Flags: waiting for provider initialization...')

    const promise = super.initialize(context)

    // `DatadogNodeServerProvider#initialize` starts a timer that is never unref'd, which would
    // otherwise keep an idle process (a short script, a serverless handler) alive for up to
    // `initializationTimeoutMs` while waiting for configuration to arrive.
    // TODO: remove once `@datadog/openfeature-node-server` unrefs this timer itself.
    this.initController?.timeoutId?.unref?.()

    // Only observes the outcome for logging; `promise` itself is returned unmodified below.
    // Guarded so a logger failure can never leave the derived promise unhandled.
    promise.then(
      () => {
        try {
          log.debug('Feature Flags: provider initialized successfully')
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
  }
}

module.exports = FlaggingProvider
