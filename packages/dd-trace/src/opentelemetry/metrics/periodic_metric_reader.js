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
  #cumulativeState
  #lastExportedState

  /**
   * Creates a new PeriodicMetricReader instance.
   *
   * @param {OtlpHttpMetricExporter} exporter - Metric exporter for sending to Datadog Agent
   * @param {number} exportInterval - Export interval in milliseconds
   * @param {string} temporalityPreference - Temporality preference: DELTA, CUMULATIVE, or LOWMEMORY
   */
  constructor (exporter, exportInterval, temporalityPreference = 'DELTA') {
    this.exporter = exporter
    this.#exportInterval = exportInterval
    this.#measurements = []
    this.#observableInstruments = []
    this.#aggregator = new MetricAggregator(temporalityPreference)
    this.#timer = null
    this.#cumulativeState = new Map() // Tracks cumulative values across export cycles
    this.#lastExportedState = new Map() // Tracks last exported values for delta calculation
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

    // Aggregate measurements into metrics with temporality handling
    const metrics = this.#aggregator.aggregate(
      allMeasurements,
      this.#cumulativeState,
      this.#lastExportedState
    )

    // Export metrics
    this.exporter.export(metrics, callback)
  }
}

/**
 * MetricAggregator aggregates individual measurements into metric data points.
 * @private
 */
class MetricAggregator {
  #temporalityPreference
  #startTime

  constructor (temporalityPreference = 'DELTA') {
    this.#temporalityPreference = temporalityPreference
    this.#startTime = Date.now() * 1e6 // Start time in nanoseconds
  }

  /**
   * Determines the temporality for a given instrument type.
   *
   * @param {string} type - The instrument type
   * @returns {string} 'DELTA', 'CUMULATIVE', or 'GAUGE'
   * @private
   */
  #getTemporality (type) {
    // UpDownCounter and Observable UpDownCounter always use CUMULATIVE
    if (type === 'updowncounter' || type === 'observable-updowncounter') {
      return 'CUMULATIVE'
    }

    // Gauge always uses last-value aggregation
    if (type === 'gauge') {
      return 'GAUGE'
    }

    // For other instruments, follow the temporality preference
    switch (this.#temporalityPreference) {
      case 'CUMULATIVE':
        return 'CUMULATIVE'
      case 'LOWMEMORY':
        // LOWMEMORY: only synchronous Counter and Histogram use DELTA
        // Observable Counter uses CUMULATIVE
        return (type === 'counter' || type === 'histogram') ? 'DELTA' : 'CUMULATIVE'
      default:
        // DELTA (default): Counter, Observable Counter, and Histogram use DELTA
        return 'DELTA'
    }
  }

  /**
   * Aggregates measurements into metrics suitable for OTLP export.
   *
   * @param {Array} measurements - Array of measurement objects
   * @param {Map} cumulativeState - State map for tracking cumulative values
   * @param {Map} lastExportedState - State map for tracking last exported values (for delta calculation)
   * @returns {Array} Array of aggregated metrics
   */
  aggregate (measurements, cumulativeState, lastExportedState) {
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
      const attrKey = JSON.stringify(attributes)
      const stateKey = `${metricKey}:${attrKey}`

      if (!metricsMap.has(metricKey)) {
        metricsMap.set(metricKey, {
          name,
          description,
          unit,
          type,
          instrumentationScope,
          temporality: this.#getTemporality(type),
          data: []
        })
      }

      const metric = metricsMap.get(metricKey)

      // Aggregate based on instrument type
      if (type === 'histogram') {
        this.#aggregateHistogram(metric, value, attributes, timestamp, stateKey, cumulativeState, lastExportedState)
      } else if (type === 'gauge' || type === 'observable-counter' || type === 'observable-updowncounter') {
        // Gauges and observable instruments use last value (observations report current total, not increments)
        this.#aggregateGauge(metric, value, attributes, timestamp)
      } else {
        // Synchronous Counters and UpDownCounters use sum aggregation
        this.#aggregateSum(metric, value, attributes, timestamp, stateKey, cumulativeState, lastExportedState)
      }
    }

    const metrics = [...metricsMap.values()]

    // Apply temporality to final aggregated metrics
    for (const metric of metrics) {
      const isDeltaType = metric.type === 'counter' ||
                         metric.type === 'observable-counter' ||
                         metric.type === 'histogram'

      if (metric.temporality === 'DELTA' && isDeltaType) {
        // For DELTA temporality, calculate difference from last export
        for (const dataPoint of metric.data) {
          const attrKey = JSON.stringify(dataPoint.attributes)
          const scopeKey = `${metric.instrumentationScope.name}@` +
            `${metric.instrumentationScope.version}@${metric.instrumentationScope.schemaUrl}`
          const stateKey = `${scopeKey}:${metric.name}:${metric.type}:${attrKey}`

          if (metric.type === 'counter' || metric.type === 'observable-counter') {
            const lastValue = lastExportedState.get(stateKey) || 0
            const currentValue = dataPoint.value
            dataPoint.value = currentValue - lastValue
            lastExportedState.set(stateKey, currentValue)
          } else if (metric.type === 'histogram') {
            const lastState = lastExportedState.get(stateKey) || {
              count: 0,
              sum: 0,
              bucketCounts: new Array(dataPoint.bucketCounts.length).fill(0)
            }
            const currentState = {
              count: dataPoint.count,
              sum: dataPoint.sum,
              min: dataPoint.min,
              max: dataPoint.max,
              bucketCounts: [...dataPoint.bucketCounts]
            }
            dataPoint.count = currentState.count - lastState.count
            dataPoint.sum = currentState.sum - lastState.sum
            dataPoint.bucketCounts = currentState.bucketCounts.map(
              (count, idx) => count - (lastState.bucketCounts[idx] || 0)
            )
            lastExportedState.set(stateKey, currentState)
          }
        }
      }
    }

    return metrics
  }

  /**
   * Finds or creates a data point in metric.data for the given attributes.
   * @private
   */
  #findOrCreateDataPoint (metric, attributes, initialDataPoint) {
    const attrKey = JSON.stringify(attributes)
    let dataPoint = metric.data.find(dp => JSON.stringify(dp.attributes) === attrKey)

    if (!dataPoint) {
      dataPoint = { attributes, ...initialDataPoint }
      metric.data.push(dataPoint)
    }

    return dataPoint
  }

  /**
   * Aggregates sum values for counters and updowncounters with temporality.
   * @private
   */
  #aggregateSum (metric, value, attributes, timestamp, stateKey, cumulativeState, lastExportedState) {
    // Initialize or update cumulative state
    if (!cumulativeState.has(stateKey)) {
      cumulativeState.set(stateKey, {
        value: 0,
        startTime: metric.temporality === 'CUMULATIVE' ? this.#startTime : timestamp
      })
    }

    const state = cumulativeState.get(stateKey)
    state.value += value

    // Find or create data point
    const dataPoint = this.#findOrCreateDataPoint(metric, attributes, {
      startTimeUnixNano: state.startTime,
      timeUnixNano: timestamp,
      value: 0
    })

    // Update the data point with cumulative state value
    // Temporality will be applied after all measurements are aggregated
    dataPoint.value = state.value
    dataPoint.timeUnixNano = timestamp
  }

  /**
   * Aggregates gauge values (last value wins).
   * @private
   */
  #aggregateGauge (metric, value, attributes, timestamp) {
    const dataPoint = this.#findOrCreateDataPoint(metric, attributes, {
      timeUnixNano: timestamp,
      value: 0
    })

    // Last value wins for gauges
    dataPoint.value = value
    dataPoint.timeUnixNano = timestamp
  }

  /**
   * Aggregates histogram values into buckets with temporality.
   * @private
   */
  #aggregateHistogram (metric, value, attributes, timestamp, stateKey, cumulativeState, lastExportedState) {
    const defaultBuckets = [0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10_000]

    // Initialize or get cumulative state
    if (!cumulativeState.has(stateKey)) {
      cumulativeState.set(stateKey, {
        count: 0,
        sum: 0,
        min: Infinity,
        max: -Infinity,
        bucketCounts: new Array(defaultBuckets.length + 1).fill(0),
        startTime: metric.temporality === 'CUMULATIVE' ? this.#startTime : timestamp
      })
    }

    const state = cumulativeState.get(stateKey)

    // Find which bucket this value belongs to
    let bucketIndex = defaultBuckets.length
    for (let i = 0; i < defaultBuckets.length; i++) {
      if (value <= defaultBuckets[i]) {
        bucketIndex = i
        break
      }
    }

    // Update cumulative state
    state.bucketCounts[bucketIndex]++
    state.count++
    state.sum += value
    state.min = Math.min(state.min, value)
    state.max = Math.max(state.max, value)

    // Find or create data point
    const dataPoint = this.#findOrCreateDataPoint(metric, attributes, {
      startTimeUnixNano: state.startTime,
      timeUnixNano: timestamp,
      count: 0,
      sum: 0,
      min: Infinity,
      max: -Infinity,
      bucketCounts: new Array(defaultBuckets.length + 1).fill(0),
      explicitBounds: defaultBuckets
    })

    // Update data point with cumulative state
    // Temporality will be applied after all measurements are aggregated
    dataPoint.count = state.count
    dataPoint.sum = state.sum
    dataPoint.min = state.min
    dataPoint.max = state.max
    dataPoint.bucketCounts = [...state.bucketCounts]
    dataPoint.timeUnixNano = timestamp
  }
}

module.exports = PeriodicMetricReader
