'use strict'

const { channel } = require('dc-polyfill')
const requireOptionalPeer = require('../../../datadog-instrumentations/src/helpers/require-optional-peer')
const log = require('../log')
const { EXPOSURE_CHANNEL } = require('./constants/constants')
const FlagEvalMetricsHook = require('./flag-eval-metrics-hook')
const SpanEnrichmentHook = require('./span-enrichment-hook')
const FlagEvalEVPHook = require('./writers/flag_eval_evp_hook')
const FlagEvaluationsWriter = require('./writers/flag_evaluations')

const { DatadogNodeServerProvider } = requireOptionalPeer('@datadog/openfeature-node-server')

/**
 * OpenFeature provider that integrates with Datadog's feature flagging system.
 * Extends DatadogNodeServerProvider to add tracer integration and configuration management.
 */
class FlaggingProvider extends DatadogNodeServerProvider {
  /** @type {SpanEnrichmentHook?} */
  #spanEnrichmentHook

  /** @type {FlagEvaluationsWriter | undefined} */
  #flagEvalEVPWriter

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

    // OTel feature_flag.evaluations hook — ALWAYS registered; untouched
    this.hooks.push(new FlagEvalMetricsHook(config))

    // EVP flagevaluation hook — gated by killswitch DD_FLAGGING_EVALUATION_COUNTS_ENABLED
    // Default: enabled (only explicit false disables); routed through config system.
    if (config.experimental.flaggingProvider.evaluationCountsEnabled) {
      this.#flagEvalEVPWriter = new FlagEvaluationsWriter(config)
      this.hooks.push(new FlagEvalEVPHook(this.#flagEvalEVPWriter))
      log.debug('%s EVP flagevaluation writer enabled', this.constructor.name)
    } else {
      log.debug('%s EVP flagevaluation writer disabled (DD_FLAGGING_EVALUATION_COUNTS_ENABLED=false)',
        this.constructor.name)
    }

    if (config.experimental.flaggingProvider.spanEnrichment?.enabled) {
      this.#spanEnrichmentHook = new SpanEnrichmentHook(tracer)
      this.hooks.push(this.#spanEnrichmentHook)
      log.info('%s span enrichment enabled', this.constructor.name)
    } else {
      log.info('%s span enrichment disabled', this.constructor.name)
    }

    log.debug('%s created with timeout: %dms', this.constructor.name,
      config.experimental.flaggingProvider.initializationTimeoutMs)
  }

  /**
   * Called when the provider is shut down.
   * Cleans up resources including channel subscriptions.
   */
  onClose () {
    this.#spanEnrichmentHook?.destroy()
    this.#flagEvalEVPWriter?.destroy()
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
