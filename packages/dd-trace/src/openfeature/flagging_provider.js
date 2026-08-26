'use strict'

const { channel } = require('dc-polyfill')

const { DatadogNodeServerProvider } = require('../../../../vendor/dist/@datadog/openfeature-node-server')
const log = require('../log')
const configurationSource = require('./configuration_source')
const { EXPOSURE_CHANNEL } = require('./constants/constants')
const FlagEvalMetricsHook = require('./flag-eval-metrics-hook')
const SpanEnrichmentHook = require('./span-enrichment-hook')
const FlagEvalEVPHook = require('./writers/flag-eval-evp-hook')
const FlagEvaluationsWriter = require('./writers/flag-evaluations')
const { setAgentStrategy } = require('./writers/util')

/**
 * OpenFeature provider that integrates with Datadog's feature flagging system.
 * Extends DatadogNodeServerProvider to add tracer integration and configuration management.
 */
class FlaggingProvider extends DatadogNodeServerProvider {
  /** @type {SpanEnrichmentHook | undefined} */
  #spanEnrichmentHook

  /** @type {FlagEvaluationsWriter | undefined} */
  #flagEvalEVPWriter

  /** @type {{ start: Function, stop: Function } | undefined} */
  #configurationSource

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
      this.hooks.push(new FlagEvalEVPHook(this.#flagEvalEVPWriter))
      // Gate delivery on the Agent advertising the EVP proxy endpoint, mirroring the
      // exposure writer (writers/util.setAgentStrategy). Until the probe resolves the
      // writer stays enabled by default; if the Agent lacks /evp_proxy/v2 the writer is
      // disabled so it stops POSTing to an unsupported endpoint (no recurring request
      // errors). Aggregation still runs, bounded by the writer's cardinality caps.
      setAgentStrategy(config, hasAgent => {
        this.#flagEvalEVPWriter?.setEnabled(hasAgent)
      })
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
   * @param {import('@openfeature/core').EvaluationContext} [context]
   * @returns {Promise<void>}
   */
  initialize (context) {
    const promise = super.initialize(context)

    // `DatadogNodeServerProvider#initialize` starts a timer that is never unref'd, which would
    // otherwise keep an idle process (a short script, a serverless handler) alive for up to
    // `initializationTimeoutMs` while waiting for configuration to arrive.
    // TODO: remove once `@datadog/openfeature-node-server` unrefs this timer itself.
    this.initController?.timeoutId?.unref?.()

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
    this.#flagEvalEVPWriter?.destroy()
    this.#flagEvalEVPWriter = undefined
  }
}

module.exports = FlaggingProvider
