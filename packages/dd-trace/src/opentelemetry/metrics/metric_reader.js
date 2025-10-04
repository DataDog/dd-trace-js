'use strict'

/**
 * @typedef {import('./meter_provider')} MeterProvider
 */

/**
 * MetricReader collects and exports metrics at a periodic interval.
 *
 * This implementation follows the OpenTelemetry JavaScript SDK PeriodicExportingMetricReader:
 * https://open-telemetry.github.io/opentelemetry-js/classes/_opentelemetry_sdk_metrics.PeriodicExportingMetricReader.html
 *
 * @class MetricReader
 */
class MetricReader {
  #timer
  #exportInterval
  #meterProvider

  /**
   * Creates a new MetricReader instance.
   *
   * @param {Object} exporter - Metric exporter for exporting to Datadog Agent
   * @param {number} exportInterval - Interval in milliseconds for periodic export
   */
  constructor (exporter, exportInterval) {
    this.exporter = exporter
    this.#exportInterval = exportInterval
    this.isShutdown = false
    this.#timer = null
    this.#meterProvider = null
  }

  /**
   * Sets the meter provider for this reader.
   * @param {MeterProvider} meterProvider - The meter provider
   */
  setMeterProvider (meterProvider) {
    this.#meterProvider = meterProvider
    this._startTimer()
  }

  /**
   * Collects metrics from all meters and exports them.
   */
  collect () {
    if (this.isShutdown || !this.#meterProvider) {
      return
    }

    const metrics = this.#meterProvider.collect()
    if (metrics.length > 0) {
      this.exporter.export(metrics, () => {})
    }
  }

  /**
   * Forces an immediate collection and export of all metrics.
   * @returns {undefined} Promise that resolves when flush is complete
   */
  forceFlush () {
    if (!this.isShutdown) {
      this.collect()
    }
  }

  /**
   * Shuts down the reader and exports any remaining metrics.
   * @returns {undefined} Promise that resolves when shutdown is complete
   */
  shutdown () {
    if (!this.isShutdown) {
      this.isShutdown = true
      this._clearTimer()
      this.collect()
      this.exporter.shutdown()
    }
  }

  /**
   * Starts the periodic export timer.
   * @private
   */
  _startTimer () {
    if (this.#timer || this.isShutdown) {
      return
    }

    this.#timer = setInterval(() => {
      this.collect()
    }, this.#exportInterval)

    // Don't keep the process alive
    if (this.#timer.unref) {
      this.#timer.unref()
    }
  }

  /**
   * Clears the periodic export timer.
   * @private
   */
  _clearTimer () {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }
}

module.exports = MetricReader
