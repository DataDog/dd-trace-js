'use strict'

/**
 * Meter provides methods to create metric instruments.
 *
 * This implementation follows the OpenTelemetry JavaScript API Meter interface:
 * https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_api.Meter.html
 *
 * @class Meter
 */
class Meter {
  #instruments

  /**
   * Creates a new Meter instance.
   *
   * @param {Object} scope - Instrumentation scope
   * @param {string} scope.name - Instrumentation scope name
   * @param {string} [scope.version] - Instrumentation scope version
   * @param {string} [scope.schemaUrl] - Instrumentation scope schema URL
   */
  constructor (scope) {
    this.instrumentationScope = scope
    this.#instruments = new Map()
  }

  /**
   * Creates a Counter instrument.
   * @param {string} name - Instrument name
   * @param {Object} [options] - Instrument options
   * @returns {Object} Counter instrument
   */
  createCounter (name, options = {}) {
    const key = `counter:${name}`
    if (!this.#instruments.has(key)) {
      this.#instruments.set(key, this._createInstrument('counter', name, options))
    }
    return this.#instruments.get(key)
  }

  /**
   * Creates an UpDownCounter instrument.
   * @param {string} name - Instrument name
   * @param {Object} [options] - Instrument options
   * @returns {Object} UpDownCounter instrument
   */
  createUpDownCounter (name, options = {}) {
    const key = `updowncounter:${name}`
    if (!this.#instruments.has(key)) {
      this.#instruments.set(key, this._createInstrument('updowncounter', name, options))
    }
    return this.#instruments.get(key)
  }

  /**
   * Creates a Histogram instrument.
   * @param {string} name - Instrument name
   * @param {Object} [options] - Instrument options
   * @returns {Object} Histogram instrument
   */
  createHistogram (name, options = {}) {
    const key = `histogram:${name}`
    if (!this.#instruments.has(key)) {
      this.#instruments.set(key, this._createInstrument('histogram', name, options))
    }
    return this.#instruments.get(key)
  }

  /**
   * Creates an ObservableGauge instrument.
   * @param {string} name - Instrument name
   * @param {Object} [options] - Instrument options
   * @returns {Object} ObservableGauge instrument
   */
  createObservableGauge (name, options = {}) {
    const key = `observablegauge:${name}`
    if (!this.#instruments.has(key)) {
      this.#instruments.set(key, this._createObservableInstrument('gauge', name, options))
    }
    return this.#instruments.get(key)
  }

  /**
   * Creates an ObservableCounter instrument.
   * @param {string} name - Instrument name
   * @param {Object} [options] - Instrument options
   * @returns {Object} ObservableCounter instrument
   */
  createObservableCounter (name, options = {}) {
    const key = `observablecounter:${name}`
    if (!this.#instruments.has(key)) {
      this.#instruments.set(key, this._createObservableInstrument('counter', name, options))
    }
    return this.#instruments.get(key)
  }

  /**
   * Creates an ObservableUpDownCounter instrument.
   * @param {string} name - Instrument name
   * @param {Object} [options] - Instrument options
   * @returns {Object} ObservableUpDownCounter instrument
   */
  createObservableUpDownCounter (name, options = {}) {
    const key = `observableupdowncounter:${name}`
    if (!this.#instruments.has(key)) {
      this.#instruments.set(key, this._createObservableInstrument('updowncounter', name, options))
    }
    return this.#instruments.get(key)
  }

  /**
   * Collects all metrics from this meter's instruments.
   * @returns {Array} Array of metric data
   */
  collect () {
    const metrics = []
    for (const instrument of this.#instruments.values()) {
      const data = instrument.collect()
      if (data) {
        metrics.push({
          name: instrument.name,
          description: instrument.description,
          unit: instrument.unit,
          type: instrument.type,
          data,
          instrumentationScope: this.instrumentationScope
        })
      }
    }
    return metrics
  }

  /**
   * Creates a synchronous instrument.
   * @private
   */
  _createInstrument (type, name, options) {
    const measurements = []
    const startTime = Date.now() * 1_000_000

    return {
      name,
      type,
      description: options.description || '',
      unit: options.unit || '',
      add (value, attributes = {}) {
        measurements.push({
          value,
          attributes,
          timestamp: Date.now() * 1_000_000
        })
      },
      record (value, attributes = {}) {
        measurements.push({
          value,
          attributes,
          timestamp: Date.now() * 1_000_000
        })
      },
      collect () {
        if (measurements.length === 0) return null

        // Aggregate measurements by attributes
        const aggregated = new Map()
        for (const measurement of measurements) {
          const key = JSON.stringify(measurement.attributes)
          if (!aggregated.has(key)) {
            aggregated.set(key, {
              attributes: measurement.attributes,
              values: [],
              startTime,
              timestamp: measurement.timestamp
            })
          }
          const agg = aggregated.get(key)
          agg.values.push(measurement.value)
          agg.timestamp = measurement.timestamp
        }

        // Clear measurements after collection
        measurements.length = 0

        const dataPoints = []
        for (const agg of aggregated.values()) {
          if (type === 'histogram') {
            // For histograms, compute statistics
            const values = agg.values
            const sum = values.reduce((a, b) => a + b, 0)
            const count = values.length
            const min = Math.min(...values)
            const max = Math.max(...values)

            dataPoints.push({
              attributes: agg.attributes,
              startTimeUnixNano: agg.startTime,
              timeUnixNano: agg.timestamp,
              count,
              sum,
              min,
              max,
              bucketCounts: [],
              explicitBounds: []
            })
          } else {
            // For counters, sum all values
            const sum = agg.values.reduce((a, b) => a + b, 0)
            dataPoints.push({
              attributes: agg.attributes,
              startTimeUnixNano: agg.startTime,
              timeUnixNano: agg.timestamp,
              value: sum
            })
          }
        }

        return dataPoints
      }
    }
  }

  /**
   * Creates an observable (asynchronous) instrument.
   * @private
   */
  _createObservableInstrument (type, name, options) {
    let callback = null

    return {
      name,
      type,
      description: options.description || '',
      unit: options.unit || '',
      addCallback (cb) {
        callback = cb
      },
      removeCallback (cb) {
        if (callback === cb) {
          callback = null
        }
      },
      collect () {
        if (!callback) return null

        const observations = []
        const observableResult = {
          observe (value, attributes = {}) {
            observations.push({
              value,
              attributes,
              timestamp: Date.now() * 1_000_000
            })
          }
        }

        try {
          callback(observableResult)
        } catch {
          // Ignore callback errors
          return null
        }

        if (observations.length === 0) return null

        return observations.map(obs => ({
          attributes: obs.attributes,
          timeUnixNano: obs.timestamp,
          value: obs.value
        }))
      }
    }
  }
}

module.exports = Meter
