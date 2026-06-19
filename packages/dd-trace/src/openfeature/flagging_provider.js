'use strict'

const { channel } = require('dc-polyfill')
const log = require('../log')
const { EXPOSURE_CHANNEL } = require('./constants/constants')
const EvalMetricsHook = require('./eval-metrics-hook')
const SpanEnrichmentHook = require('./span-enrichment-hook')
const FlagEvaluationsWriter = require('./writers/flag_evaluations')
const FlagEvalEVPHook = require('./writers/flag_eval_hook')

// Bundler-opaque require for the optional peer chain
// `@datadog/openfeature-node-server` -> `@openfeature/server-sdk` ->
// `@openfeature/core`. Same shape as `helpers/rewriter/compiler.js`.
// Refs: https://github.com/DataDog/dd-trace-js/issues/8635
// eslint-disable-next-line camelcase, no-undef
const runtimeRequire = typeof __webpack_require__ === 'function' ? __non_webpack_require__ : require
const { DatadogNodeServerProvider } = runtimeRequire(['@datadog/openfeature', 'node', 'server'].join('-'))

/**
 * OpenFeature provider that integrates with Datadog's feature flagging system.
 * Extends DatadogNodeServerProvider to add tracer integration and configuration management.
 */
class FlaggingProvider extends DatadogNodeServerProvider {
  /** @type {SpanEnrichmentHook?} */
  #spanEnrichmentHook

  /** @type {FlagEvaluationsWriter | undefined} */
  #flagEvalWriter

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
    this.hooks.push(new EvalMetricsHook(config))

    // EVP flagevaluation hook — gated by killswitch DD_FLAGGING_EVALUATION_COUNTS_ENABLED
    // Default: enabled (only explicit false disables); routed through config system.
    if (config.experimental.flaggingProvider.evaluationCountsEnabled) {
      this.#flagEvalWriter = new FlagEvaluationsWriter(config)
      this.hooks.push(new FlagEvalEVPHook(this.#flagEvalWriter))
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
    this.#flagEvalWriter?.destroy()
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
