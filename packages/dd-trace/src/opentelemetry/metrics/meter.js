'use strict'

const { VERSION: packageVersion } = require('../../../../../version')
const {
  Counter, UpDownCounter, Histogram, Gauge, ObservableGauge, ObservableCounter, ObservableUpDownCounter
} = require('./instruments')
const log = require('../../log')
const { METRIC_TYPES } = require('./constants')

/**
 * @typedef {import('@opentelemetry/api').MetricOptions} MetricOptions
 * @typedef {import('@opentelemetry/core').InstrumentationScope} InstrumentationScope
 */

/**
 * Meter provides methods to create metric instruments.
 *
 * This implementation follows the OpenTelemetry JavaScript API Meter:
 * https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_api._opentelemetry_api.Meter.html
 *
 * @class Meter
 */
class Meter {
  #instrumentationScope
  #instruments = new Map()
  /**
   * Creates a new Meter instance.
   *
   * @param {MeterProvider} meterProvider - Parent meter provider
   * @param {InstrumentationScope} instrumentationScope - Instrumentation scope information
   * @param {string} [instrumentationScope.name] - Meter name (defaults to 'dd-trace-js')
   * @param {string} [instrumentationScope.version] - Meter version (defaults to tracer version)
   * @param {string} [instrumentationScope.schemaUrl] - Schema URL
   * @param {Object} [instrumentationScope.attributes] - Attributes for the instrumentation scope
   */
  constructor (
    meterProvider,
    { name = 'dd-trace-js', version = packageVersion, schemaUrl = '', attributes = {} } = {}
  ) {
    this.meterProvider = meterProvider
    this.#instrumentationScope = {
      name,
      version,
      schemaUrl,
      attributes,
    }
  }

  /**
   * Gets an existing instrument or creates a new one if it doesn't exist.
   * Instruments are cached by type and normalized (lowercase) name.
   *
   *
   * @param {string} name - Instrument name (will be normalized to lowercase)
   * @param {string} type - Instrument type (e.g., 'counter', 'histogram', 'gauge')
   * @param {Function} InstrumentClass - Constructor for the instrument type
   * @param {MetricOptions} [options] - Instrument options (description, unit, etc.)
   * @returns {Instrument} The instrument instance (new or cached)
   */
  #getOrCreateInstrument (name, type, InstrumentClass, options) {
    const normalizedName = name.toLowerCase()
    const key = `${type}:${normalizedName}`
    let instrument = this.#instruments.get(key)
    if (!instrument) {
      instrument = new InstrumentClass(
        normalizedName, options, this.#instrumentationScope, this.meterProvider.reader
      )
      this.#instruments.set(key, instrument)
    }
    return instrument
  }

  /**
   * Creates a Counter instrument.
   *
   * @param {string} name - Instrument name (case-insensitive)
   * @param {MetricOptions} [options] - Instrument options
   * @returns {Counter} Counter instrument
   */
  createCounter (name, options = {}) {
    return this.#getOrCreateInstrument(name, METRIC_TYPES.COUNTER, Counter, options)
  }

  /**
   * Creates an UpDownCounter instrument.
   *
   * @param {string} name - Instrument name
   * @param {MetricOptions} [options] - Instrument options
   * @returns {UpDownCounter} UpDownCounter instrument
   */
  createUpDownCounter (name, options = {}) {
    return this.#getOrCreateInstrument(name, METRIC_TYPES.UPDOWNCOUNTER, UpDownCounter, options)
  }

  /**
   * Creates a Histogram instrument.
   *
   * @param {string} name - Instrument name (case-insensitive)
   * @param {MetricOptions} [options] - Instrument options
   * @returns {Histogram} Histogram instrument
   */
  createHistogram (name, options = {}) {
    return this.#getOrCreateInstrument(name, METRIC_TYPES.HISTOGRAM, Histogram, options)
  }

  /**
   * Creates a Gauge instrument.
   *
   * @param {string} name - Instrument name (case-insensitive)
   * @param {MetricOptions} [options] - Instrument options
   * @returns {Gauge} Gauge instrument
   */
  createGauge (name, options = {}) {
    return this.#getOrCreateInstrument(name, METRIC_TYPES.GAUGE, Gauge, options)
  }

  /**
   * Creates an ObservableGauge instrument.
   *
   * @param {string} name - Instrument name (case-insensitive)
   * @param {MetricOptions} [options] - Instrument options
   * @returns {ObservableGauge} ObservableGauge instrument
   */
  createObservableGauge (name, options = {}) {
    return this.#getOrCreateInstrument(name, METRIC_TYPES.OBSERVABLEGAUGE, ObservableGauge, options)
  }

  /**
   * Creates an ObservableCounter instrument.
   *
   * @param {string} name - Instrument name (case-insensitive)
   * @param {MetricOptions} [options] - Instrument options
   * @returns {ObservableCounter} ObservableCounter instrument
   */
  createObservableCounter (name, options = {}) {
    return this.#getOrCreateInstrument(name, METRIC_TYPES.OBSERVABLECOUNTER, ObservableCounter, options)
  }

  /**
   * Creates an ObservableUpDownCounter instrument.
   *
   * @param {string} name - Instrument name (case-insensitive)
   * @param {MetricOptions} [options] - Instrument options
   * @returns {ObservableUpDownCounter} ObservableUpDownCounter instrument
   */
  createObservableUpDownCounter (name, options = {}) {
    return this.#getOrCreateInstrument(name, METRIC_TYPES.OBSERVABLEUPDOWNCOUNTER, ObservableUpDownCounter, options)
  }

  /**
   * Adds a batch observable callback (not implemented).
   *
   * @param {Function} callback - Batch observable callback
   * @param {Array} observables - Array of observable instruments
   */
  addBatchObservableCallback (callback, observables) {
    log.warn('addBatchObservableCallback is not implemented')
  }

  /**
   * Removes a batch observable callback (not implemented).
   *
   * @param {Function} callback - Batch observable callback
   * @param {Array} observables - Array of observable instruments
   */
  removeBatchObservableCallback (callback, observables) {
    log.warn('removeBatchObservableCallback is not implemented')
  }
}

module.exports = Meter
