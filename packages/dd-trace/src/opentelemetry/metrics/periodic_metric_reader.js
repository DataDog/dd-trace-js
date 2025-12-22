'use strict'

const {
  METRIC_TYPES, TEMPORALITY, DEFAULT_HISTOGRAM_BUCKETS, DEFAULT_MAX_MEASUREMENT_QUEUE_SIZE
} = require('./constants')
const log = require('../../log')
const { stableStringify } = require('../otlp/otlp_transformer_base')

/**
 * @typedef {import('@opentelemetry/api').Attributes} Attributes
 * @typedef {import('@opentelemetry/core').InstrumentationScope} InstrumentationScope
 * @typedef {import('./instruments').Measurement} Measurement
 */

/**
 * @typedef {Object} NumberDataPoint
 * @property {Attributes} attributes - Number data point metric attributes
 * @property {string} attrKey - Stable stringified key for attributes
 * @property {number} timeUnixNano - Timestamp in nanoseconds
 * @property {number} startTimeUnixNano - Start timestamp for cumulative metrics
 * @property {number} value - Metric value
 */

/**
 * @typedef {Object} HistogramDataPoint
 * @property {Attributes} attributes - Histogram data point metric attributes
 * @property {string} attrKey - Stable stringified key for attributes
 * @property {number} timeUnixNano - Timestamp in nanoseconds
 * @property {number} startTimeUnixNano - Start timestamp
 * @property {number} count - Number of observations
 * @property {number} sum - Sum of all observations
 * @property {number} min - Minimum value observed
 * @property {number} max - Maximum value observed
 * @property {number[]} bucketCounts - Count per histogram bucket
 * @property {number[]} explicitBounds - Histogram bucket boundaries
 */

/**
 * @typedef {Object} AggregatedMetricDataPoint
 * @property {Attributes} attributes - Aggregated metric data point metric attributes
 * @property {string} attrKey - Stable stringified key for attributes
 * @property {number} timeUnixNano - Timestamp in nanoseconds
 * @property {number} startTimeUnixNano - Start timestamp
 * @property {number} count - Number of observations
 * @property {number} sum - Sum of all observations
 * @property {number} min - Minimum value observed
 * @property {number} max - Maximum value observed
 * @property {number[]} bucketCounts - Count per histogram bucket
 * @property {number[]} explicitBounds - Histogram bucket boundaries
 */

/**
 * @typedef {Object} AggregatedMetric
 * @property {string} name - Metric name
 * @property {string} description - Metric description
 * @property {string} unit - Metric unit
 * @property {string} type - Metric type from METRIC_TYPES
 * @property {InstrumentationScope} instrumentationScope - Instrumentation scope
 * @property {string} temporality - Temporality from TEMPORALITY constants
 * @property {Map<string, AggregatedMetricDataPoint>} dataPointMap - Map of attribute keys to data points
 */

/**
 * PeriodicMetricReader collects and exports metrics at a regular interval.
 *
 * This implementation follows the OpenTelemetry JavaScript SDK MetricReader pattern:
 * https://open-telemetry.github.io/opentelemetry-js/classes/_opentelemetry_sdk-metrics.PeriodicExportingMetricReader.html
 *
 * @class PeriodicMetricReader
 */
class PeriodicMetricReader {
  #measurements = []
  #cumulativeState = new Map()
  #lastExportedState = new Map()
  #droppedCount = 0
  #timer = null
  #isShutdown = false
  #exportInterval
  #aggregator

  /**
   * Creates a new PeriodicMetricReader instance.
   *
   * @param {OtlpHttpMetricExporter} exporter - Metric exporter for sending to Datadog Agent
   * @param {number} exportInterval - Export interval in milliseconds
   * @param {string} temporalityPreference - Temporality preference: DELTA, CUMULATIVE, or LOWMEMORY
   * @param {number} maxBatchedQueueSize - Maximum number of measurements to queue before dropping
   */
  constructor (exporter, exportInterval, temporalityPreference, maxBatchedQueueSize) {
    this.exporter = exporter
    this.observableInstruments = new Set()
    this.#exportInterval = exportInterval
    this.#aggregator = new MetricAggregator(temporalityPreference, maxBatchedQueueSize)
    this.#startTimer()
  }

  /**
   * Records a measurement from a synchronous instrument.
   *
   * @param {Measurement} measurement - The measurement data
   */
  record (measurement) {
    if (this.#measurements.length >= DEFAULT_MAX_MEASUREMENT_QUEUE_SIZE || this.#isShutdown) {
      this.#droppedCount++
      return
    }
    this.#measurements.push(measurement)
  }

  /**
   * Forces an immediate collection and export of all metrics.
   * @returns {void}
   */
  forceFlush () {
    if (this.#isShutdown) {
      log.warn(`PeriodicMetricReader is shutdown. ${this.#droppedCount} measurement(s) were dropped`)
      return
    }
    this.#collectAndExport()
  }

  /**
   * Shuts down the reader and stops periodic collection.
   * @returns {void}
   */
  shutdown () {
    if (this.#isShutdown) {
      log.warn('PeriodicMetricReader is already shutdown')
      return
    }
    this.#isShutdown = true
    this.#clearTimer()
    this.forceFlush()
  }

  /**
   * Starts the periodic export timer.
   *
   */
  #startTimer () {
    if (this.#timer) return

    this.#timer = setInterval(() => {
      this.#collectAndExport()
    }, this.#exportInterval).unref()
  }

  /**
   * Clears the periodic export timer.
   *
   */
  #clearTimer () {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  /**
   * Collects measurements and exports metrics.
   *
   * @param {Function} [callback] - Called after export completes
   */
  #collectAndExport (callback = () => {}) {
    // Atomically drain measurements for export. New measurements can be recorded
    // during export without interfering with this batch.
    const allMeasurements = this.#measurements.splice(0)

    for (const instrument of this.observableInstruments) {
      const observableMeasurements = instrument.collect()

      if (allMeasurements.length >= DEFAULT_MAX_MEASUREMENT_QUEUE_SIZE) {
        this.#droppedCount += observableMeasurements.length
        continue
      }

      const remainingCapacity = DEFAULT_MAX_MEASUREMENT_QUEUE_SIZE - allMeasurements.length

      if (observableMeasurements.length <= remainingCapacity) {
        allMeasurements.push(...observableMeasurements)
      } else {
        allMeasurements.push(...observableMeasurements.slice(0, remainingCapacity))
        this.#droppedCount += observableMeasurements.length - remainingCapacity
      }
    }

    if (this.#droppedCount > 0) {
      log.warn(
        `Metric queue exceeded limit (max: ${DEFAULT_MAX_MEASUREMENT_QUEUE_SIZE}). ` +
        `Dropping ${this.#droppedCount} measurements. `
      )
      this.#droppedCount = 0
    }

    if (allMeasurements.length === 0) {
      callback()
      return
    }

    const metrics = this.#aggregator.aggregate(
      allMeasurements,
      this.#cumulativeState,
      this.#lastExportedState
    )

    this.exporter.export(metrics, callback)
  }
}

/**
 * MetricAggregator aggregates individual measurements into metric data points.
 *
 */
class MetricAggregator {
  #startTime = Number(process.hrtime.bigint())
  #temporalityPreference
  #maxBatchedQueueSize

  constructor (temporalityPreference, maxBatchedQueueSize) {
    this.#temporalityPreference = temporalityPreference
    this.#maxBatchedQueueSize = maxBatchedQueueSize
  }

  /**
   * Gets the temporality for a given metric type.
   *
   * @param {string} type - Metric type from METRIC_TYPES
   * @returns {string} Temporality from TEMPORALITY
   */
  #getTemporality (type) {
    // UpDownCounter and Observable UpDownCounter always use CUMULATIVE
    if (type === METRIC_TYPES.UPDOWNCOUNTER || type === METRIC_TYPES.OBSERVABLEUPDOWNCOUNTER) {
      return TEMPORALITY.CUMULATIVE
    }

    // Gauge always uses last-value aggregation
    if (type === METRIC_TYPES.GAUGE) {
      return TEMPORALITY.GAUGE
    }

    switch (this.#temporalityPreference) {
      case TEMPORALITY.CUMULATIVE:
        return TEMPORALITY.CUMULATIVE
      case TEMPORALITY.LOWMEMORY:
        // LOWMEMORY: only synchronous Counter and Histogram use DELTA, Observable Counter uses CUMULATIVE
        return (type === METRIC_TYPES.COUNTER || type === METRIC_TYPES.HISTOGRAM)
          ? TEMPORALITY.DELTA
          : TEMPORALITY.CUMULATIVE
      default:
        return TEMPORALITY.DELTA
    }
  }

  /**
   * Aggregates measurements into metrics.
   *
   * @param {Measurement[]} measurements - The measurements to aggregate
   * @param {Map<string, any>} cumulativeState - The cumulative state of the metrics
   * @param {Map<string, any>} lastExportedState - The last exported state of the metrics
   * @returns {Iterable<AggregatedMetric>} The aggregated metrics
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

      const scopeKey = this.#getScopeKey(instrumentationScope)
      const metricKey = `${scopeKey}:${name}:${type}`
      const attrKey = stableStringify(attributes)
      const stateKey = this.#getStateKey(scopeKey, name, type, attrKey)

      let metric = metricsMap.get(metricKey)
      if (!metric) {
        if (metricsMap.size >= this.#maxBatchedQueueSize) {
          log.warn(
            `Metric queue exceeded limit (max: ${this.#maxBatchedQueueSize}). ` +
            `Dropping metric: ${metricKey}, value: ${value}. ` +
            'Consider increasing OTEL_BSP_MAX_QUEUE_SIZE or decreasing OTEL_METRIC_EXPORT_INTERVAL.'
          )
          continue
        }
        metric = {
          name,
          description,
          unit,
          type,
          instrumentationScope,
          temporality: this.#getTemporality(type),
          dataPointMap: new Map()
        }
        metricsMap.set(metricKey, metric)
      }

      if (type === METRIC_TYPES.COUNTER || type === METRIC_TYPES.UPDOWNCOUNTER) {
        this.#aggregateSum(metric, value, attributes, attrKey, timestamp, stateKey, cumulativeState)
      } else if (type === METRIC_TYPES.HISTOGRAM) {
        this.#aggregateHistogram(metric, value, attributes, attrKey, timestamp, stateKey, cumulativeState)
      } else {
        this.#aggregateLastValue(metric, value, attributes, attrKey, timestamp)
      }
    }

    this.#applyDeltaTemporality(metricsMap, lastExportedState)
    return metricsMap
  }

  /**
   * Gets unique identifier for a given instrumentation scope.
   *
   * @param {InstrumentationScope} instrumentationScope - The instrumentation scope
   * @returns {string} - The scope identifier
   */
  #getScopeKey (instrumentationScope) {
    return `${instrumentationScope.name}@${instrumentationScope.version}@${instrumentationScope.schemaUrl}`
  }

  /**
   * Gets unique identifier for a given metric.
   *
   * @param {string} scopeKey - The scope identifier
   * @param {string} name - The metric name
   * @param {string} type - The metric type from METRIC_TYPES
   * @param {string} attrKey - The attribute key
   * @returns {string} - The metric identifier
   */
  #getStateKey (scopeKey, name, type, attrKey) {
    return `${scopeKey}:${name}:${type}:${attrKey}`
  }

  /**
   * Checks if a given metric type is a delta type.
   *
   * @param {string} type - The metric type from METRIC_TYPES
   * @returns {boolean} - True if the metric type is a delta type
   */
  #isDeltaType (type) {
    return type === METRIC_TYPES.COUNTER ||
           type === METRIC_TYPES.OBSERVABLECOUNTER ||
           type === METRIC_TYPES.HISTOGRAM
  }

  /**
   * Applies delta temporality to the metrics.
   *
   * @param {Iterable<AggregatedMetric>} metrics - The metrics to apply delta temporality to
   * @param {Map<string, any>} lastExportedState - The last exported state of the metrics
   * @returns {void}
   */
  #applyDeltaTemporality (metrics, lastExportedState) {
    for (const metric of metrics) {
      if (metric.temporality === TEMPORALITY.DELTA && this.#isDeltaType(metric.type)) {
        const scopeKey = this.#getScopeKey(metric.instrumentationScope)

        for (const dataPoint of metric.dataPointMap.values()) {
          const stateKey = this.#getStateKey(scopeKey, metric.name, metric.type, dataPoint.attrKey)

          if (metric.type === METRIC_TYPES.COUNTER || metric.type === METRIC_TYPES.OBSERVABLECOUNTER) {
            const lastValue = lastExportedState.get(stateKey) || 0
            const currentValue = dataPoint.value
            dataPoint.value = currentValue - lastValue
            lastExportedState.set(stateKey, currentValue)
          } else if (metric.type === METRIC_TYPES.HISTOGRAM) {
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
  }

  /**
   * Finds or creates a data point for a given metric.
   *
   * @param {AggregatedMetric} metric - The metric to find or create a data point for
   * @param {Attributes} attributes - The attributes of the metric
   * @param {string} attrKey - The attribute key
   * @param {Function} createInitialDataPoint - Function to create an initial data point
   * @returns {NumberDataPoint|HistogramDataPoint} - The data point
   */
  #findOrCreateDataPoint (metric, attributes, attrKey, createInitialDataPoint) {
    let dataPoint = metric.dataPointMap.get(attrKey)

    if (!dataPoint) {
      dataPoint = { attributes, attrKey, ...createInitialDataPoint() }
      metric.dataPointMap.set(attrKey, dataPoint)
    }

    return dataPoint
  }

  /**
   * Records the sum of all values for a given metric.
   * Creates a new data point if it doesn't exist.
   *
   * @param {AggregatedMetric} metric - The metric to aggregate a sum for
   * @param {number} value - The value to aggregate
   * @param {Attributes} attributes - The attributes of the metric
   * @param {string} attrKey - The attribute key
   * @param {number} timestamp - The timestamp of the measurement
   * @param {string} stateKey - The state key
   * @param {Map<string, any>} cumulativeState - The cumulative state of the metrics
   */
  #aggregateSum (metric, value, attributes, attrKey, timestamp, stateKey, cumulativeState) {
    if (!cumulativeState.has(stateKey)) {
      cumulativeState.set(stateKey, {
        value: 0,
        startTime: metric.temporality === TEMPORALITY.CUMULATIVE ? this.#startTime : timestamp
      })
    }

    const state = cumulativeState.get(stateKey)
    state.value += value

    const dataPoint = this.#findOrCreateDataPoint(metric, attributes, attrKey, () => ({
      startTimeUnixNano: state.startTime,
      timeUnixNano: timestamp,
      value: 0
    }))

    dataPoint.value = state.value
    dataPoint.timeUnixNano = timestamp
  }

  /**
   * Overwrites the last recorded value for a given metric or
   * creates a new data point if it doesn't exist.
   *
   * @param {AggregatedMetric} metric - The metric to aggregate a last value for
   * @param {number} value - The value to aggregate
   * @param {Attributes} attributes - The attributes of the metric
   * @param {string} attrKey - The attribute key
   * @param {number} timestamp - The timestamp of the measurement
   */
  #aggregateLastValue (metric, value, attributes, attrKey, timestamp) {
    const dataPoint = this.#findOrCreateDataPoint(metric, attributes, attrKey, () => ({
      timeUnixNano: timestamp,
      value: 0
    }))

    dataPoint.value = value
    dataPoint.timeUnixNano = timestamp
  }

  /**
   * Aggregates histogram values by distributing them into buckets.
   * Tracks count, sum, min, max, and per-bucket counts and creates
   * a new data point if it doesn't exist.
   *
   * @param {AggregatedMetric} metric - The metric to aggregate a histogram for
   * @param {number} value - The value to aggregate
   * @param {Attributes} attributes - The attributes of the metric
   * @param {string} attrKey - The attribute key
   * @param {number} timestamp - The timestamp of the measurement
   * @param {string} stateKey - The state key
   * @param {Map<string, any>} cumulativeState - The cumulative state of the metrics
   * @returns {void}
   */
  #aggregateHistogram (metric, value, attributes, attrKey, timestamp, stateKey, cumulativeState) {
    if (!cumulativeState.has(stateKey)) {
      cumulativeState.set(stateKey, {
        count: 0,
        sum: 0,
        min: Infinity,
        max: -Infinity,
        bucketCounts: new Array(DEFAULT_HISTOGRAM_BUCKETS.length + 1).fill(0),
        startTime: metric.temporality === TEMPORALITY.CUMULATIVE ? this.#startTime : timestamp
      })
    }

    const state = cumulativeState.get(stateKey)

    let bucketIndex = DEFAULT_HISTOGRAM_BUCKETS.length
    for (let i = 0; i < DEFAULT_HISTOGRAM_BUCKETS.length; i++) {
      if (value <= DEFAULT_HISTOGRAM_BUCKETS[i]) {
        bucketIndex = i
        break
      }
    }

    state.bucketCounts[bucketIndex]++
    state.count++
    state.sum += value
    state.min = Math.min(state.min, value)
    state.max = Math.max(state.max, value)

    const dataPoint = this.#findOrCreateDataPoint(metric, attributes, attrKey, () => ({
      startTimeUnixNano: state.startTime,
      timeUnixNano: timestamp,
      count: 0,
      sum: 0,
      min: Infinity,
      max: -Infinity,
      bucketCounts: new Array(DEFAULT_HISTOGRAM_BUCKETS.length + 1).fill(0),
      explicitBounds: DEFAULT_HISTOGRAM_BUCKETS
    }))

    dataPoint.count = state.count
    dataPoint.sum = state.sum
    dataPoint.min = state.min
    dataPoint.max = state.max
    dataPoint.bucketCounts = [...state.bucketCounts]
    dataPoint.timeUnixNano = timestamp
  }
}

module.exports = PeriodicMetricReader
