'use strict'

const packageVersion = require('../../../../../package.json').version
const { Counter, UpDownCounter, Histogram, ObservableGauge } = require('./instruments')

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
 * https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_api.Meter.html
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
   */
  constructor (meterProvider, instrumentationScope) {
    this.meterProvider = meterProvider
    this.#instrumentationScope = {
      name: instrumentationScope?.name || 'dd-trace-js',
      version: instrumentationScope?.version || packageVersion,
      schemaUrl: instrumentationScope?.schemaUrl || ''
    }
    this.#instruments = new Map()
  }

  /**
   * Creates a Counter instrument.
   *
   * @param {string} name - Instrument name
   * @param {Object} [options] - Instrument options
   * @param {string} [options.description] - Instrument description
   * @param {string} [options.unit] - Unit of measurement
   * @param {Attributes} [options.valueType] - Value type (currently ignored, always numeric)
   * @returns {Counter} Counter instrument
   */
  createCounter (name, options = {}) {
    const key = `counter:${name}`
    if (!this.#instruments.has(key)) {
      const counter = new Counter(name, options, this.#instrumentationScope, this.meterProvider.reader)
      this.#instruments.set(key, counter)
    }
    return this.#instruments.get(key)
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
    const key = `updowncounter:${name}`
    if (!this.#instruments.has(key)) {
      const counter = new UpDownCounter(name, options, this.#instrumentationScope, this.meterProvider.reader)
      this.#instruments.set(key, counter)
    }
    return this.#instruments.get(key)
  }

  /**
   * Creates a Histogram instrument.
   *
   * @param {string} name - Instrument name
   * @param {Object} [options] - Instrument options
   * @param {string} [options.description] - Instrument description
   * @param {string} [options.unit] - Unit of measurement
   * @param {Attributes} [options.valueType] - Value type (currently ignored, always numeric)
   * @returns {Histogram} Histogram instrument
   */
  createHistogram (name, options = {}) {
    const key = `histogram:${name}`
    if (!this.#instruments.has(key)) {
      const histogram = new Histogram(name, options, this.#instrumentationScope, this.meterProvider.reader)
      this.#instruments.set(key, histogram)
    }
    return this.#instruments.get(key)
  }

  /**
   * Creates an ObservableGauge instrument.
   *
   * @param {string} name - Instrument name
   * @param {Object} [options] - Instrument options
   * @param {string} [options.description] - Instrument description
   * @param {string} [options.unit] - Unit of measurement
   * @param {Attributes} [options.valueType] - Value type (currently ignored, always numeric)
   * @returns {ObservableGauge} ObservableGauge instrument
   */
  createObservableGauge (name, options = {}) {
    const key = `gauge:${name}`
    if (!this.#instruments.has(key)) {
      const gauge = new ObservableGauge(name, options, this.#instrumentationScope, this.meterProvider.reader)
      this.#instruments.set(key, gauge)
    }
    return this.#instruments.get(key)
  }

  /**
   * Creates an ObservableCounter instrument.
   *
   * @param {string} name - Instrument name
   * @param {Object} [options] - Instrument options
   * @param {string} [options.description] - Instrument description
   * @param {string} [options.unit] - Unit of measurement
   * @returns {ObservableGauge} ObservableCounter instrument (implemented as gauge for now)
   */
  createObservableCounter (name, options = {}) {
    // ObservableCounter is similar to ObservableGauge but monotonic
    // For now, implement as gauge - can be enhanced later
    return this.createObservableGauge(name, options)
  }

  /**
   * Creates an ObservableUpDownCounter instrument.
   *
   * @param {string} name - Instrument name
   * @param {Object} [options] - Instrument options
   * @param {string} [options.description] - Instrument description
   * @param {string} [options.unit] - Unit of measurement
   * @returns {ObservableGauge} ObservableUpDownCounter instrument (implemented as gauge for now)
   */
  createObservableUpDownCounter (name, options = {}) {
    // ObservableUpDownCounter is similar to ObservableGauge
    return this.createObservableGauge(name, options)
  }
}

module.exports = Meter
