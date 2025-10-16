'use strict'

const packageVersion = require('../../../../../package.json').version
const { Counter, UpDownCounter, Histogram, Gauge, ObservableGauge } = require('./instruments')

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
    const normalizedName = name.toLowerCase()
    const key = `counter:${normalizedName}`
    if (!this.#instruments.has(key)) {
      const counter = new Counter(normalizedName, options, this.#instrumentationScope, this.meterProvider.reader)
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
    const normalizedName = name.toLowerCase()
    const key = `updowncounter:${normalizedName}`
    if (!this.#instruments.has(key)) {
      const counter = new UpDownCounter(normalizedName, options, this.#instrumentationScope, this.meterProvider.reader)
      this.#instruments.set(key, counter)
    }
    return this.#instruments.get(key)
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
    const normalizedName = name.toLowerCase()
    const key = `histogram:${normalizedName}`
    if (!this.#instruments.has(key)) {
      const histogram = new Histogram(normalizedName, options, this.#instrumentationScope, this.meterProvider.reader)
      this.#instruments.set(key, histogram)
    }
    return this.#instruments.get(key)
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
    const normalizedName = name.toLowerCase()
    const key = `gauge:${normalizedName}`
    if (!this.#instruments.has(key)) {
      const gauge = new Gauge(normalizedName, options, this.#instrumentationScope, this.meterProvider.reader)
      this.#instruments.set(key, gauge)
    }
    return this.#instruments.get(key)
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
    const normalizedName = name.toLowerCase()
    const key = `observable-gauge:${normalizedName}`
    if (!this.#instruments.has(key)) {
      const gauge = new ObservableGauge(normalizedName, options, this.#instrumentationScope, this.meterProvider.reader)
      this.#instruments.set(key, gauge)
    }
    return this.#instruments.get(key)
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
    const { ObservableCounter } = require('./instruments')
    const normalizedName = name.toLowerCase()
    const key = `observable-counter:${normalizedName}`
    if (!this.#instruments.has(key)) {
      const counter = new ObservableCounter(
        normalizedName, options, this.#instrumentationScope, this.meterProvider.reader
      )
      this.#instruments.set(key, counter)
    }
    return this.#instruments.get(key)
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
    const { ObservableUpDownCounter } = require('./instruments')
    const normalizedName = name.toLowerCase()
    const key = `observable-updowncounter:${normalizedName}`
    if (!this.#instruments.has(key)) {
      const updown = new ObservableUpDownCounter(
        normalizedName, options, this.#instrumentationScope, this.meterProvider.reader
      )
      this.#instruments.set(key, updown)
    }
    return this.#instruments.get(key)
  }
}

module.exports = Meter
