'use strict'

const { metrics } = require('@opentelemetry/api')
const { context } = require('@opentelemetry/api')
const Meter = require('./meter')
const log = require('../../log')
const ContextManager = require('../context_manager')

/**
 * @typedef {import('@opentelemetry/api').Meter} OtelMeter
 * @typedef {import('./metric_reader')} MetricReader
 */

/**
 * MeterProvider is the main entry point for creating meters with a metric reader for Datadog Agent export.
 *
 * This implementation follows the OpenTelemetry JavaScript API MeterProvider interface:
 * https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_api.MeterProvider.html
 *
 * @class MeterProvider
 * @implements {import('@opentelemetry/api').MeterProvider}
 */
class MeterProvider {
  #meters
  #contextManager

  /**
   * Creates a new MeterProvider instance with a metric reader for Datadog Agent export.
   *
   * @param {Object} [options] - MeterProvider options
   * @param {MetricReader} [options.reader] - MetricReader instance for exporting metrics to Datadog Agent
   */
  constructor (options = {}) {
    this.reader = options.reader
    this.#meters = new Map()
    this.#contextManager = new ContextManager()
    this.isShutdown = false

    // Set the meter provider on the reader
    if (this.reader) {
      this.reader.setMeterProvider(this)
    }
  }

  /**
   * Gets or creates a meter instance.
   *
   * @param {string|Object} nameOrOptions - Meter name or options object
   * @param {string} [version] - Meter version (when nameOrOptions is a string)
   * @param {Object} [options] - Additional options (when nameOrOptions is a string)
   * @returns {OtelMeter} Meter instance
   */
  getMeter (nameOrOptions, version, options = {}) {
    if (this.isShutdown) {
      return this._createNoOpMeter()
    }

    let name, meterOptions
    if (typeof nameOrOptions === 'string') {
      name = nameOrOptions
      meterOptions = { version, ...options }
    } else {
      name = nameOrOptions.name
      meterOptions = nameOrOptions
    }

    const meterVersion = meterOptions.version || ''
    const meterSchemaUrl = meterOptions?.schemaUrl || ''
    const key = `${name}@${meterVersion}@${meterSchemaUrl}`

    if (!this.#meters.has(key)) {
      this.#meters.set(key, new Meter({ name, version: meterVersion, schemaUrl: meterSchemaUrl }))
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
    // Set context manager, this is required to correlate metrics to spans
    context.setGlobalContextManager(this.#contextManager)
    if (!metrics.setGlobalMeterProvider(this)) {
      metrics.getMeterProvider().setDelegate(this)
    }
  }

  /**
   * Collects metrics from all meters.
   * @returns {Array} Array of metric data
   */
  collect () {
    const allMetrics = []
    for (const meter of this.#meters.values()) {
      const metrics = meter.collect()
      allMetrics.push(...metrics)
    }
    return allMetrics
  }

  /**
   * Forces a flush of all pending metrics.
   * @returns {undefined} Promise that resolves when flush is complete
   */
  forceFlush () {
    if (this.isShutdown) {
      throw new Error('MeterProvider is shutdown')
    }
    return this.reader?.forceFlush()
  }

  /**
   * Shuts down the meter provider and all associated readers.
   * @returns {undefined} Promise that resolves when shutdown is complete
   */
  shutdown () {
    if (!this.isShutdown) {
      this.isShutdown = true
      this.reader?.shutdown()
    }
  }

  /**
   * Creates a no-op meter for use when the provider is shutdown.
   * @returns {OtelMeter} A no-op meter instance
   * @private
   */
  _createNoOpMeter () {
    const noOpInstrument = {
      add: () => {},
      record: () => {},
      addCallback: () => {},
      removeCallback: () => {}
    }

    return {
      instrumentationScope: {
        name: 'dd-trace-js',
        version: ''
      },
      createCounter: () => noOpInstrument,
      createUpDownCounter: () => noOpInstrument,
      createHistogram: () => noOpInstrument,
      createObservableGauge: () => noOpInstrument,
      createObservableCounter: () => noOpInstrument,
      createObservableUpDownCounter: () => noOpInstrument
    }
  }
}

module.exports = MeterProvider
