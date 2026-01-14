'use strict'

const Meter = require('./meter')

/**
 * @typedef {import('@opentelemetry/api').Meter} Meter
 * @typedef {import('@opentelemetry/api').MeterOptions} MeterOptions
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
  #meters = new Map()

  /**
   * Creates a new MeterProvider instance with a single reader for Datadog Agent export.
   *
   * @param {MeterOptions} [options] - MeterProvider options
   * @param {PeriodicMetricReader} [options.reader] - Single MetricReader instance for
   *   exporting metrics to Datadog Agent
   */
  constructor (options = {}) {
    this.reader = options.reader
  }

  /**
   * Gets or creates a meter instance.
   *
   * @param {string} name - Meter name (case-insensitive)
   * @param {string} [version] - Meter version
   * @param {MeterOptions} [options] - Additional options
   * @returns {Meter} Meter instance
   */
  getMeter (name, version = '', { schemaUrl = '', attributes = {} } = {}) {
    const normalizedName = name.toLowerCase()
    const key = `${normalizedName}@${version}@${schemaUrl}`
    let meter = this.#meters.get(key)
    if (!meter) {
      meter = new Meter(this, { name: normalizedName, version, schemaUrl, attributes })
      this.#meters.set(key, meter)
    }
    return meter
  }
}

module.exports = MeterProvider
