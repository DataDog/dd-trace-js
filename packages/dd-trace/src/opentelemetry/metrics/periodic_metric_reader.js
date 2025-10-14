'use strict'

/**
 * @typedef {import('@opentelemetry/api').Attributes} Attributes
 * @typedef {import('@opentelemetry/core').InstrumentationScope} InstrumentationScope
 */

/**
 * PeriodicMetricReader collects and exports metrics at a regular interval.
 *
 * This implementation follows the OpenTelemetry JavaScript SDK MetricReader pattern:
 * https://open-telemetry.github.io/opentelemetry-js/classes/_opentelemetry_sdk_metrics.PeriodicExportingMetricReader.html
 *
 * @class PeriodicMetricReader
 */
class PeriodicMetricReader {
  #measurements
  #observableInstruments
  #timer
  #exportInterval
  #aggregator

  /**
   * Creates a new PeriodicMetricReader instance.
   *
   * @param {OtlpHttpMetricExporter} exporter - Metric exporter for sending to Datadog Agent
   * @param {number} exportInterval - Export interval in milliseconds
   */
  constructor (exporter, exportInterval) {
    this.exporter = exporter
    this.#exportInterval = exportInterval
    this.#measurements = []
    this.#observableInstruments = []
    this.#aggregator = new MetricAggregator()
    this.#timer = null
    this.#startTimer()
  }

  /**
   * Records a measurement from a synchronous instrument.
   *
   * @param {Object} measurement - The measurement data
   */
  record (measurement) {
    this.#measurements.push(measurement)
  }

  /**
   * Registers an observable instrument for periodic collection.
   *
   * @param {ObservableGauge} instrument - The observable instrument to register
   */
  registerObservableInstrument (instrument) {
    if (!this.#observableInstruments.includes(instrument)) {
      this.#observableInstruments.push(instrument)
    }
  }

  /**
   * Forces an immediate collection and export of all metrics.
   * @returns {Promise<void>} Promise that resolves when export is complete
   */
  forceFlush () {
    return new Promise((resolve) => {
      this.#collectAndExport(() => resolve())
    })
  }

  /**
   * Shuts down the reader and stops periodic collection.
   * @returns {Promise<void>} Promise that resolves when shutdown is complete
   */
  shutdown () {
    this.#clearTimer()
    return this.forceFlush()
  }

  /**
   * Starts the periodic export timer.
   * @private
   */
  #startTimer () {
    if (this.#timer) {
      return
    }

    this.#timer = setInterval(() => {
      this.#collectAndExport()
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
  #clearTimer () {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  /**
   * Collects measurements from all sources and exports them.
   * @private
   */
  #collectAndExport (callback = () => {}) {
    // Collect synchronous measurements
    const synchronousMeasurements = this.#measurements.splice(0)

    // Collect asynchronous measurements from observable instruments
    const asynchronousMeasurements = []
    for (const instrument of this.#observableInstruments) {
      const observations = instrument.collect()
      asynchronousMeasurements.push(...observations)
    }

    // Combine all measurements
    const allMeasurements = [...synchronousMeasurements, ...asynchronousMeasurements]

    if (allMeasurements.length === 0) {
      callback()
      return
    }

    // Aggregate measurements into metrics
    const metrics = this.#aggregator.aggregate(allMeasurements)

    // Export metrics
    this.exporter.export(metrics, callback)
  }
}

/**
 * MetricAggregator aggregates individual measurements into metric data points.
 * @private
 */
class MetricAggregator {
  /**
   * Aggregates measurements into metrics suitable for OTLP export.
   *
   * @param {Array} measurements - Array of measurement objects
   * @returns {Array} Array of aggregated metrics
   */
  aggregate (measurements) {
    const metricsMap = new Map()

    for (const measurement of measurements) {
      const {
        name,
        description,
        unit,
        type,
        instrumentationScope,
        value,
        attributes,
        timestamp
      } = measurement

      // Create unique key for this metric
      const scopeKey = `${instrumentationScope.name}@${instrumentationScope.version}@${instrumentationScope.schemaUrl}`
      const metricKey = `${scopeKey}:${name}:${type}`

      if (!metricsMap.has(metricKey)) {
        metricsMap.set(metricKey, {
          name,
          description,
          unit,
          type,
          instrumentationScope,
          data: []
        })
      }

      const metric = metricsMap.get(metricKey)

      // For histograms, we need to aggregate into buckets
      if (type === 'histogram') {
        this.#aggregateHistogram(metric, value, attributes, timestamp)
      } else {
        // For counters and gauges, record individual data points
        metric.data.push({
          attributes,
          timeUnixNano: String(timestamp),
          startTimeUnixNano: String(timestamp), // For counters
          value
        })
      }
    }

    return [...metricsMap.values()]
  }

  /**
   * Aggregates histogram values into buckets.
   * @private
   */
  #aggregateHistogram (metric, value, attributes, timestamp) {
    // Simple histogram aggregation with default buckets
    const defaultBuckets = [0, 5, 10, 25, 50, 75, 100, 250, 500, 1000]
    const bucketCounts = new Array(defaultBuckets.length + 1).fill(0)

    // Find which bucket this value belongs to
    let bucketIndex = 0
    for (let i = 0; i < defaultBuckets.length; i++) {
      if (value <= defaultBuckets[i]) {
        bucketIndex = i
        break
      }
      bucketIndex = i + 1
    }
    bucketCounts[bucketIndex]++

    // For simplicity, create a data point for each histogram record
    // In a production implementation, you'd want to aggregate multiple records
    metric.data.push({
      attributes,
      startTimeUnixNano: String(timestamp),
      timeUnixNano: String(timestamp),
      count: 1,
      sum: value,
      min: value,
      max: value,
      bucketCounts,
      explicitBounds: defaultBuckets
    })
  }
}

module.exports = PeriodicMetricReader
