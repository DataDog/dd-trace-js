'use strict'

const { METRIC_TYPES, TEMPORALITY, DEFAULT_HISTOGRAM_BUCKETS } = require('./constants')

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
   * @returns {void}
   */
  forceFlush () {
    this.#collectAndExport()
  }

  /**
   * Shuts down the reader and stops periodic collection.
   * @returns {void}
   */
  shutdown () {
    this.#clearTimer()
    this.forceFlush()
  }

  #startTimer () {
    if (this.#timer) return

    this.#timer = setInterval(() => {
      this.#collectAndExport()
    }, this.#exportInterval).unref()
  }

  #clearTimer () {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  #collectAndExport (callback = () => {}) {
    const allMeasurements = this.#measurements.splice(0)

    for (const instrument of this.#observableInstruments) {
      allMeasurements.push(...instrument.collect())
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
 * @private
 */
class MetricAggregator {
  #temporalityPreference
  #startTime

  constructor (temporalityPreference = TEMPORALITY.DELTA) {
    this.#temporalityPreference = temporalityPreference
    this.#startTime = Number(process.hrtime.bigint())
  }

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
      const attrKey = JSON.stringify(attributes)
      const stateKey = this.#getStateKey(scopeKey, name, type, attrKey)

      if (!metricsMap.has(metricKey)) {
        metricsMap.set(metricKey, {
          name,
          description,
          unit,
          type,
          instrumentationScope,
          temporality: this.#getTemporality(type),
          data: [],
          dataPointMap: new Map()
        })
      }

      const metric = metricsMap.get(metricKey)

      if (type === METRIC_TYPES.HISTOGRAM) {
        this.#aggregateHistogram(metric, value, attributes, attrKey, timestamp, stateKey, cumulativeState)
      } else if (type === METRIC_TYPES.GAUGE ||
                 type === METRIC_TYPES.OBSERVABLECOUNTER ||
                 type === METRIC_TYPES.OBSERVABLEUPDOWNCOUNTER) {
        // Gauges and observable instruments use last value (observations report current total, not increments)
        this.#aggregateLastValue(metric, value, attributes, attrKey, timestamp)
      } else {
        // Synchronous Counters and UpDownCounters use sum aggregation
        this.#aggregateSum(metric, value, attributes, attrKey, timestamp, stateKey, cumulativeState)
      }
    }

    const metrics = [...metricsMap.values()]

    this.#applyDeltaTemporality(metrics, lastExportedState)

    return metrics
  }

  #getScopeKey (instrumentationScope) {
    return `${instrumentationScope.name}@${instrumentationScope.version}@${instrumentationScope.schemaUrl}`
  }

  #getStateKey (scopeKey, name, type, attrKey) {
    return `${scopeKey}:${name}:${type}:${attrKey}`
  }

  #isDeltaType (type) {
    return type === METRIC_TYPES.COUNTER ||
           type === METRIC_TYPES.OBSERVABLECOUNTER ||
           type === METRIC_TYPES.HISTOGRAM
  }

  #applyDeltaTemporality (metrics, lastExportedState) {
    for (const metric of metrics) {
      if (metric.temporality === TEMPORALITY.DELTA && this.#isDeltaType(metric.type)) {
        const scopeKey = this.#getScopeKey(metric.instrumentationScope)

        for (const dataPoint of metric.data) {
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

      delete metric.dataPointMap
    }
  }

  #findOrCreateDataPoint (metric, attributes, attrKey, createInitialDataPoint) {
    let dataPoint = metric.dataPointMap.get(attrKey)

    if (!dataPoint) {
      dataPoint = { attributes, attrKey, ...createInitialDataPoint() }
      metric.data.push(dataPoint)
      metric.dataPointMap.set(attrKey, dataPoint)
    }

    return dataPoint
  }

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

  #aggregateLastValue (metric, value, attributes, attrKey, timestamp) {
    const dataPoint = this.#findOrCreateDataPoint(metric, attributes, attrKey, () => ({
      timeUnixNano: timestamp,
      value: 0
    }))

    dataPoint.value = value
    dataPoint.timeUnixNano = timestamp
  }

  #aggregateHistogram (metric, value, attributes, attrKey, timestamp, stateKey, cumulativeState) {
    const buckets = DEFAULT_HISTOGRAM_BUCKETS

    if (!cumulativeState.has(stateKey)) {
      cumulativeState.set(stateKey, {
        count: 0,
        sum: 0,
        min: Infinity,
        max: -Infinity,
        bucketCounts: new Array(buckets.length + 1).fill(0),
        startTime: metric.temporality === TEMPORALITY.CUMULATIVE ? this.#startTime : timestamp
      })
    }

    const state = cumulativeState.get(stateKey)

    let bucketIndex = buckets.length
    for (let i = 0; i < buckets.length; i++) {
      if (value <= buckets[i]) {
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
      bucketCounts: new Array(buckets.length + 1).fill(0),
      explicitBounds: buckets
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
