'use strict'

const { channel } = require('dc-polyfill')

const { DatadogNodeServerProvider } = require('../../../../vendor/dist/@datadog/openfeature-node-server')
const log = require('../log')
const configurationSource = require('./configuration_source')
const { EXPOSURE_CHANNEL } = require('./constants/constants')
const DebugLoggingHook = require('./debug-logging-hook')
const EvalMetricsHook = require('./eval-metrics-hook')
const SpanEnrichmentHook = require('./span-enrichment-hook')

/**
 * OpenFeature provider that integrates with Datadog's feature flagging system.
 * Extends DatadogNodeServerProvider to add tracer integration and configuration management.
 */
class FlaggingProvider extends DatadogNodeServerProvider {
  /** @type {SpanEnrichmentHook | undefined} */
  #spanEnrichmentHook

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

    this.hooks.push(new EvalMetricsHook(config))
    this.hooks.push(new DebugLoggingHook())

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
    log.debug('Feature Flags: waiting for provider initialization...')

    const promise = super.initialize(context)

    // `DatadogNodeServerProvider#initialize` starts a timer that is never unref'd, which would
    // otherwise keep an idle process (a short script, a serverless handler) alive for up to
    // `initializationTimeoutMs` while waiting for configuration to arrive.
    // TODO: remove once `@datadog/openfeature-node-server` unrefs this timer itself.
    this.initController?.timeoutId?.unref?.()

    // Observes the outcome for logging only, on a separate promise chain. Does not alter
    // it: `promise` itself is returned unmodified below, so the caller still sees the
    // original resolution or rejection.
    promise.then(
      () => log.debug('Feature Flags: provider initialized successfully'),
      (error) => log.error('Feature Flags: provider failed to initialize: %s', error.message)
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
  }
}

module.exports = FlaggingProvider
