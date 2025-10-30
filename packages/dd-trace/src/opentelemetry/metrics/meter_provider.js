'use strict'

const { metrics } = require('@opentelemetry/api')
const Meter = require('./meter')
const log = require('../../log')
const { context } = require('@opentelemetry/api')
const ContextManager = require('../context_manager')

/**
 * @typedef {import('@opentelemetry/api').Meter} Meter
 * @typedef {import('./periodic_metric_reader')} PeriodicMetricReader
 */

/**
 * MeterProvider is the main entry point for creating meters with a single reader for Datadog Agent export.
 *
 * This implementation follows the OpenTelemetry JavaScript API MeterProvider interface:
 * https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_api._opentelemetry_api.MeterProvider.html
 *
 * @class MeterProvider
 * @implements {import('@opentelemetry/api').MeterProvider}
 */
class MeterProvider {
  #meters
  #contextManager

  /**
   * Creates a new MeterProvider instance with a single reader for Datadog Agent export.
   *
   * @param {Object} [options] - MeterProvider options
   * @param {PeriodicMetricReader} [options.reader] - Single MetricReader instance for
   *   exporting metrics to Datadog Agent
   */
  constructor (options = {}) {
    this.reader = options.reader
    this.#meters = new Map()
    this.#contextManager = new ContextManager()
    this.isShutdown = false
  }

  /**
   * Gets or creates a meter instance.
   *
   * @param {string} name - Meter name (case-insensitive)
   * @param {string} [version] - Meter version
   * @param {Object} [options] - Additional options
   * @param {string} [options.schemaUrl] - Schema URL for the meter
   * @param {Object} [options.attributes] - Attributes for the instrumentation scope
   * @returns {Meter} Meter instance
   */
  getMeter (name, version = '', options = {}) {
    if (this.isShutdown) {
      return this.#createNoOpMeter()
    }

    const normalizedName = name.toLowerCase()
    const meterVersion = version || ''
    const schemaUrl = options?.schemaUrl || ''
    const attributes = options?.attributes || {}
    const attrsKey = JSON.stringify(attributes)
    const key = `${normalizedName}@${meterVersion}@${schemaUrl}@${attrsKey}`

    if (!this.#meters.has(key)) {
      this.#meters.set(key, new Meter(this, { name: normalizedName, version: meterVersion, schemaUrl, attributes }))
    }
    return this.#meters.get(key)
  }

  /**
   * Registers this meter provider as the global provider.
   */
  register () {
    if (this.isShutdown) {
      log.warn('Cannot register after shutdown')
      return
    }
    // Set context manager (may be needed for future trace/metrics correlation)
    context.setGlobalContextManager(this.#contextManager)
    metrics.setGlobalMeterProvider(this)
  }

  /**
   * Forces a flush of all pending metrics.
   * @returns {void}
   */
  forceFlush () {
    if (!this.isShutdown && this.reader) this.reader.forceFlush()
  }

  /**
   * Shuts down the meter provider and all associated readers.
   * @returns {void}
   */
  shutdown () {
    if (!this.isShutdown) {
      this.isShutdown = true
      if (this.reader) {
        this.reader.shutdown()
      }
    }
  }

  /**
   * Creates a no-op meter for use when the provider is shutdown.
   * @returns {Meter} A no-op meter instance
   * @private
   */
  #createNoOpMeter () {
    return {
      createCounter: () => ({ add: () => {} }),
      createUpDownCounter: () => ({ add: () => {} }),
      createHistogram: () => ({ record: () => {} }),
      createGauge: () => ({ record: () => {} }),
      createObservableGauge: () => ({ addCallback: () => {} }),
      createObservableCounter: () => ({ addCallback: () => {} }),
      createObservableUpDownCounter: () => ({ addCallback: () => {} })
    }
  }
}

module.exports = MeterProvider
