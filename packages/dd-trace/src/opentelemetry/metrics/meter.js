'use strict'

const packageVersion = require('../../../../../package.json').version
const {
  Counter, UpDownCounter, Histogram, Gauge, ObservableGauge, ObservableCounter, ObservableUpDownCounter
} = require('./instruments')
const log = require('../../log')
const { METRIC_TYPES } = require('./constants')

/**
 * @typedef {import('@opentelemetry/api').Counter} Counter
 * @typedef {import('@opentelemetry/api').UpDownCounter} UpDownCounter
 * @typedef {import('@opentelemetry/api').Histogram} Histogram
 * @typedef {import('@opentelemetry/api').ObservableGauge} ObservableGauge
 * @typedef {import('@opentelemetry/api').Attributes} Attributes
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
  #instruments

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
  constructor (meterProvider, instrumentationScope) {
    this.meterProvider = meterProvider
    this.#instrumentationScope = {
      name: instrumentationScope?.name || 'dd-trace-js',
      version: instrumentationScope?.version || packageVersion,
      schemaUrl: instrumentationScope?.schemaUrl || '',
      attributes: instrumentationScope?.attributes || {}
    }
    this.#instruments = new Map()
  }

  #getOrCreateInstrument (name, type, InstrumentClass, options = {}) {
    const normalizedName = name.toLowerCase()
    const key = `${type}:${normalizedName}`
    if (!this.#instruments.has(key)) {
      const instrument = new InstrumentClass(
        normalizedName, options, this.#instrumentationScope, this.meterProvider.reader
      )
      this.#instruments.set(key, instrument)
    }
    return this.#instruments.get(key)
  }

  /**
   * Creates a Counter instrument.
   *
   * @param {string} name - Instrument name (case-insensitive)
   * @param {Object} [options] - Instrument options
   * @param {string} [options.description] - Instrument description
   * @param {string} [options.unit] - Unit of measurement
   * @param {Attributes} [options.valueType] - Value type (currently ignored, always numeric)
   * @returns {Counter} Counter instrument
   */
  createCounter (name, options = {}) {
    return this.#getOrCreateInstrument(name, METRIC_TYPES.COUNTER, Counter, options)
  }

  /**
   * Creates an UpDownCounter instrument.
   *
   * @param {string} name - Instrument name
   * @param {Object} [options] - Instrument options
   * @param {string} [options.description] - Instrument description
   * @param {string} [options.unit] - Unit of measurement
   * @param {Attributes} [options.valueType] - Value type (currently ignored, always numeric)
   * @returns {UpDownCounter} UpDownCounter instrument
   */
  createUpDownCounter (name, options = {}) {
    return this.#getOrCreateInstrument(name, METRIC_TYPES.UPDOWNCOUNTER, UpDownCounter, options)
  }

  /**
   * Creates a Histogram instrument.
   *
   * @param {string} name - Instrument name (case-insensitive)
   * @param {Object} [options] - Instrument options
   * @param {string} [options.description] - Instrument description
   * @param {string} [options.unit] - Unit of measurement
   * @param {Attributes} [options.valueType] - Value type (currently ignored, always numeric)
   * @returns {Histogram} Histogram instrument
   */
  createHistogram (name, options = {}) {
    return this.#getOrCreateInstrument(name, METRIC_TYPES.HISTOGRAM, Histogram, options)
  }

  /**
   * Creates a Gauge instrument.
   *
   * @param {string} name - Instrument name (case-insensitive)
   * @param {Object} [options] - Instrument options
   * @param {string} [options.description] - Instrument description
   * @param {string} [options.unit] - Unit of measurement
   * @param {Attributes} [options.valueType] - Value type (currently ignored, always numeric)
   * @returns {Gauge} Gauge instrument
   */
  createGauge (name, options = {}) {
    return this.#getOrCreateInstrument(name, METRIC_TYPES.GAUGE, Gauge, options)
  }

  /**
   * Creates an ObservableGauge instrument.
   *
   * @param {string} name - Instrument name (case-insensitive)
   * @param {Object} [options] - Instrument options
   * @param {string} [options.description] - Instrument description
   * @param {string} [options.unit] - Unit of measurement
   * @param {Attributes} [options.valueType] - Value type (currently ignored, always numeric)
   * @returns {ObservableGauge} ObservableGauge instrument
   */
  createObservableGauge (name, options = {}) {
    return this.#getOrCreateInstrument(name, METRIC_TYPES.OBSERVABLEGAUGE, ObservableGauge, options)
  }

  /**
   * Creates an ObservableCounter instrument.
   *
   * @param {string} name - Instrument name (case-insensitive)
   * @param {Object} [options] - Instrument options
   * @param {string} [options.description] - Instrument description
   * @param {string} [options.unit] - Unit of measurement
   * @returns {ObservableCounter} ObservableCounter instrument
   */
  createObservableCounter (name, options = {}) {
    return this.#getOrCreateInstrument(name, METRIC_TYPES.OBSERVABLECOUNTER, ObservableCounter, options)
  }

  /**
   * Creates an ObservableUpDownCounter instrument.
   *
   * @param {string} name - Instrument name (case-insensitive)
   * @param {Object} [options] - Instrument options
   * @param {string} [options.description] - Instrument description
   * @param {string} [options.unit] - Unit of measurement
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
