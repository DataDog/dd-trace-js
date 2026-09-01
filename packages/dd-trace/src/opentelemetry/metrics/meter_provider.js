'use strict'

const Meter = require('./meter')

/**
 * @typedef {import('@opentelemetry/api').Meter} Meter
 * @typedef {import('@opentelemetry/api').MeterOptions} MeterOptions
 * @typedef {import('./periodic_metric_reader')} PeriodicMetricReader
 * @typedef {{ timeoutMillis?: number }} LifecycleOptions
 */

/**
 * Runs a reader lifecycle operation with an optional caller timeout.
 *
 * @param {LifecycleOptions} options - Lifecycle options
 * @param {(done: (error?: Error) => void) => void} operation - Reader operation
 * @returns {Promise<void>} Resolves when the operation completes
 */
function runLifecycleOperation (options, operation) {
  return new Promise((resolve, reject) => {
    const timeoutMillis = options?.timeoutMillis
    let timer
    let completed = false
    const complete = error => {
      if (completed) return
      completed = true
      if (timer !== undefined) clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }

    try {
      operation(complete)
    } catch (error) {
      complete(error)
      return
    }

    if (!completed && timeoutMillis != null) {
      timer = setTimeout(() => {
        const error = new Error('Operation timed out.')
        error.name = 'TimeoutError'
        complete(error)
      }, timeoutMillis)
    }
  })
}

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
  #isShutdown = false

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

  /**
   * Requests an immediate metric collection and export.
   *
   * @param {LifecycleOptions} [options] - Lifecycle options
   * @returns {Promise<void>} Resolves when the export completes
   */
  forceFlush (options = {}) {
    if (this.#isShutdown) return Promise.resolve()
    return runLifecycleOperation(options, done => {
      if (this.reader) this.reader.forceFlush(done)
      else done()
    })
  }

  /**
   * Shuts down metric collection after one final export.
   *
   * @param {LifecycleOptions} [options] - Lifecycle options
   * @returns {Promise<void>} Resolves when shutdown completes
   */
  shutdown (options = {}) {
    if (this.#isShutdown) return Promise.resolve()
    return runLifecycleOperation(options, done => {
      this.#isShutdown = true
      if (this.reader) this.reader.shutdown(done)
      else done()
    })
  }
}

module.exports = MeterProvider
