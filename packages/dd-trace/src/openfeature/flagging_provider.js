'use strict'

const { channel } = require('dc-polyfill')
const log = require('../log')
const { EXPOSURE_CHANNEL } = require('./constants/constants')
const EvalMetricsHook = require('./eval-metrics-hook')
const { DatadogNodeServerProvider } = require('./require-provider')
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
    // Call parent constructor with required options and timeout
    super({
      exposureChannel: channel(EXPOSURE_CHANNEL),
      initializationTimeoutMs: config.experimental.flaggingProvider.initializationTimeoutMs,
    })

    this._tracer = tracer
    this._config = config

    // @ts-expect-error The upstream constructor always initializes its optional hooks property.
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
  }

  /**
   * Called when the provider is shut down.
   * Cleans up resources including channel subscriptions.
   */
  onClose () {
    this.#configurationSource?.stop()
    this.#configurationSource = undefined
    this.#spanEnrichmentHook?.destroy()
  }

  /**
   * Attaches and starts the provider's first-party configuration source.
   * Repeated calls preserve the original source and dispose of the duplicate.
   *
   * @internal
   * @param {{ start: Function, stop: Function }} source - Configuration source lifecycle.
   */
  _setConfigurationSource (source) {
    if (this.#configurationSource) {
      log.warn('%s already has a configuration source; ignoring duplicate source', this.constructor.name)
      source.stop()
      return
    }
    this.#configurationSource = source
    source.start()
  }

  /**
<<<<<<< HEAD
=======
   * Attaches and starts the provider's first-party configuration source.
   * Repeated calls preserve the original source and dispose of the duplicate.
   *
   * @internal
   * @param {{ start: Function, stop: Function }} source - Configuration source lifecycle.
   */
  _setConfigurationSource (source) {
    if (this.#configurationSource) {
      log.warn('%s already has a configuration source; ignoring duplicate source', this.constructor.name)
      source.stop()
      return
    }
    this.#configurationSource = source
    source.start()
  }

  /**
>>>>>>> bd5962c651 (fix(openfeature): harden configuration source handling)
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
