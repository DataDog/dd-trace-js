'use strict'

const { channel } = require('dc-polyfill')
const log = require('../log')
const configurationSource = require('./configuration_source')
const { EXPOSURE_CHANNEL } = require('./constants/constants')
const FlagEvalMetricsHook = require('./flag-eval-metrics-hook')
const SpanEnrichmentHook = require('./span-enrichment-hook')
const FlagEvalEVPHook = require('./writers/flag_eval_evp_hook')
const FlagEvaluationsWriter = require('./writers/flag_evaluations')

const { DatadogNodeServerProvider } = require('./require-provider')

/**
 * OpenFeature provider that integrates with Datadog's feature flagging system.
 * Extends DatadogNodeServerProvider to add tracer integration and configuration management.
 */
/**
 * Atomic snapshot pairing the active configuration with its consent value.
 * A single field read returns both — no torn read possible between them.
 *
 * @typedef {object} FfeSnapshot
 * @property {import('@datadog/openfeature-node-server').UniversalFlagConfigurationV1 | undefined} configuration
 * @property {boolean} observeFullEvaluationData
 */

/** @type {FfeSnapshot} */
const EMPTY_SNAPSHOT = Object.freeze({
  configuration: undefined,
  observeFullEvaluationData: false,
})

class FlaggingProvider extends DatadogNodeServerProvider {
  /** @type {SpanEnrichmentHook | undefined} */
  #spanEnrichmentHook

  /** @type {FlagEvaluationsWriter | undefined} */
  #flagEvalEVPWriter

  /** @type {{ start: Function, stop: Function } | undefined} */
  #configurationSource

  /**
   * Atomic {configuration, observeFullEvaluationData} pair, replaced as a
   * single reference by `setConfiguration`. The EVP hook reads consent from
   * `this.#snapshot.observeFullEvaluationData` synchronously at hook entry, so
   * a Remote Config swap between the hook's `finally` and the writer's flush
   * cannot retroactively apply a different environment's policy.
   *
   * Fail-closed: strict `=== true` coercion means absent, `null`, or any
   * non-boolean value all resolve to `false`.
   *
   * @type {FfeSnapshot}
   */
  #snapshot = EMPTY_SNAPSHOT

  /**
   * Bound arrow function exposed to the EVP hook so no public consent getter
   * exists on this class — external callers cannot bypass the intended path.
   * Deleting this after upstream metadata stamping lands is straightforward.
   */
  #getConsent = () => this.#snapshot.observeFullEvaluationData

  /**
   * @param {import('../tracer')} tracer - Datadog tracer instance
   * @param {import('../config/config-base')} config - Tracer configuration object
   */
  constructor (tracer, config) {
    super({
      exposureChannel: channel(EXPOSURE_CHANNEL),
      initializationTimeoutMs: config.experimental.flaggingProvider.initializationTimeoutMs,
    })

    // OTel feature_flag.evaluations hook — ALWAYS registered; untouched
    this.hooks.push(new FlagEvalMetricsHook(config))

    // EVP flagevaluation hook — gated by killswitch DD_FLAGGING_EVALUATION_COUNTS_ENABLED
    // Default: enabled (only explicit false disables); routed through config system.
    if (config.experimental.flaggingProvider.evaluationCountsEnabled) {
      this.#flagEvalEVPWriter = new FlagEvaluationsWriter(config)
      this.hooks.push(new FlagEvalEVPHook(this.#flagEvalEVPWriter, this.#getConsent))
      log.debug('%s EVP flagevaluation writer enabled', this.constructor.name)
    } else {
      log.debug('%s EVP flagevaluation writer disabled (DD_FLAGGING_EVALUATION_COUNTS_ENABLED=false)',
        this.constructor.name)
    }

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
   * Replaces the active UFC and its consent snapshot as a single atomic step.
   * Strict `=== true` on `observeFullEvaluationData` means absent, explicit
   * `null`, wrong-typed values, and — critically — a value nested inside
   * `configuration.environment` (the FFL-2784 placement-drift trap) all fail
   * closed to `false`. Only a UFC-root boolean `true` grants opt-in.
   *
   * @param {import('@datadog/openfeature-node-server').UniversalFlagConfigurationV1 | undefined} configuration
   */
  setConfiguration (configuration) {
    super.setConfiguration(configuration)
    this.#snapshot = configuration === undefined
      ? EMPTY_SNAPSHOT
      : Object.freeze({
        configuration,
        observeFullEvaluationData: configuration.observeFullEvaluationData === true,
      })
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
    this.#flagEvalEVPWriter?.destroy()
    this.#flagEvalEVPWriter = undefined
  }
}

module.exports = FlaggingProvider
