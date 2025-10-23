'use strict'

const { sanitizeAttributes } = require('@opentelemetry/core')

/**
 * @typedef {import('@opentelemetry/api').Attributes} Attributes
 * @typedef {import('@opentelemetry/core').InstrumentationScope} InstrumentationScope
 */

/**
 * Base class for all metric instruments.
 * @private
 */
class Instrument {
  constructor (name, options, instrumentationScope, reader) {
    this.name = name
    this.description = options.description || ''
    this.unit = options.unit || ''
    this.instrumentationScope = instrumentationScope
    this.reader = reader
  }
}

/**
 * Counter is a synchronous instrument that supports non-negative increments.
 *
 * @class Counter
 * @extends Instrument
 */
class Counter extends Instrument {
  /**
   * Adds a value to the counter.
   *
   * @param {number} value - The value to add (must be non-negative)
   * @param {Attributes} [attributes] - Attributes to associate with this measurement
   * @param {Context} [context] - Context (currently unused, for API compatibility)
   */
  add (value, attributes = {}, context) {
    if (!this.reader || value < 0) {
      return
    }

    const measurement = {
      name: this.name,
      description: this.description,
      unit: this.unit,
      type: 'counter',
      instrumentationScope: this.instrumentationScope,
      value,
      attributes: sanitizeAttributes(attributes),
      timestamp: Number(process.hrtime.bigint())
    }

    this.reader.record(measurement)
  }
}

/**
 * UpDownCounter is a synchronous instrument that supports increments and decrements.
 *
 * @class UpDownCounter
 * @extends Instrument
 */
class UpDownCounter extends Instrument {
  /**
   * Adds a value to the counter (can be negative).
   *
   * @param {number} value - The value to add (can be negative)
   * @param {Attributes} [attributes] - Attributes to associate with this measurement
   * @param {Context} [context] - Context (currently unused, for API compatibility)
   */
  add (value, attributes = {}, context) {
    if (!this.reader) {
      return
    }

    const measurement = {
      name: this.name,
      description: this.description,
      unit: this.unit,
      type: 'updowncounter',
      instrumentationScope: this.instrumentationScope,
      value,
      attributes: sanitizeAttributes(attributes),
      timestamp: Number(process.hrtime.bigint())
    }

    this.reader.record(measurement)
  }
}

/**
 * Histogram is a synchronous instrument that records a distribution of values.
 *
 * @class Histogram
 * @extends Instrument
 */
class Histogram extends Instrument {
  /**
   * Records a value in the histogram.
   * Negative values are ignored per OpenTelemetry specification.
   *
   * @param {number} value - The value to record (negative values are ignored)
   * @param {Attributes} [attributes] - Attributes to associate with this measurement
   * @param {Context} [context] - Context (currently unused, for API compatibility)
   */
  record (value, attributes = {}, context) {
    if (!this.reader || value < 0) {
      return
    }

    const measurement = {
      name: this.name,
      description: this.description,
      unit: this.unit,
      type: 'histogram',
      instrumentationScope: this.instrumentationScope,
      value,
      attributes: sanitizeAttributes(attributes),
      timestamp: Number(process.hrtime.bigint())
    }

    this.reader.record(measurement)
  }
}

/**
 * Gauge is a synchronous instrument that records instantaneous values.
 * Each call to record() replaces the previous value.
 *
 * @class Gauge
 * @extends Instrument
 */
class Gauge extends Instrument {
  /**
   * Records an instantaneous gauge value.
   *
   * @param {number} value - The value to record
   * @param {Attributes} [attributes] - Attributes to associate with this measurement
   * @param {Context} [context] - Context (currently unused, for API compatibility)
   */
  record (value, attributes = {}, context) {
    if (!this.reader) {
      return
    }

    const measurement = {
      name: this.name,
      description: this.description,
      unit: this.unit,
      type: 'gauge',
      instrumentationScope: this.instrumentationScope,
      value,
      attributes: sanitizeAttributes(attributes),
      timestamp: Number(process.hrtime.bigint())
    }

    this.reader.record(measurement)
  }
}

/**
 * ObservableGauge is an asynchronous instrument that reports current values.
 *
 * @class ObservableGauge
 * @extends Instrument
 */
class ObservableGauge extends Instrument {
  #callbacks

  constructor (name, options, instrumentationScope, reader) {
    super(name, options, instrumentationScope, reader)
    this.#callbacks = []
  }

  /**
   * Adds a callback function to observe gauge values.
   *
   * @param {Function} callback - Callback function that receives an ObservableResult
   */
  addCallback (callback) {
    if (typeof callback === 'function') {
      this.#callbacks.push(callback)
      // Register with reader if available
      if (this.reader) {
        this.reader.registerObservableInstrument(this)
      }
    }
  }

  /**
   * Removes a callback function.
   *
   * @param {Function} callback - Callback function to remove
   */
  removeCallback (callback) {
    const index = this.#callbacks.indexOf(callback)
    if (index !== -1) {
      this.#callbacks.splice(index, 1)
    }
  }

  /**
   * Collects observations from all registered callbacks.
   * @private
   */
  collect () {
    const observations = []
    const observableResult = {
      observe: (value, attributes = {}) => {
        observations.push({
          name: this.name,
          description: this.description,
          unit: this.unit,
          type: 'gauge',
          instrumentationScope: this.instrumentationScope,
          value,
          attributes: sanitizeAttributes(attributes),
          timestamp: Number(process.hrtime.bigint())
        })
      }
    }

    for (const callback of this.#callbacks) {
      try {
        callback(observableResult)
      } catch {
        // Silently ignore callback errors to prevent breaking collection
      }
    }

    return observations
  }
}

/**
 * ObservableCounter instrument for asynchronous counter observations.
 * @class ObservableCounter
 * @extends Instrument
 */
class ObservableCounter extends Instrument {
  #callbacks

  constructor (name, options, instrumentationScope, reader) {
    super(name, options, instrumentationScope, reader)
    this.#callbacks = []
  }

  addCallback (callback) {
    if (typeof callback === 'function') {
      this.#callbacks.push(callback)
      if (this.reader) {
        this.reader.registerObservableInstrument(this)
      }
    }
  }

  removeCallback (callback) {
    const index = this.#callbacks.indexOf(callback)
    if (index !== -1) {
      this.#callbacks.splice(index, 1)
    }
  }

  collect () {
    const observations = []
    const observableResult = {
      observe: (value, attributes = {}) => {
        observations.push({
          name: this.name,
          description: this.description,
          unit: this.unit,
          type: 'observable-counter',
          instrumentationScope: this.instrumentationScope,
          value,
          attributes: sanitizeAttributes(attributes),
          timestamp: Number(process.hrtime.bigint())
        })
      }
    }

    for (const callback of this.#callbacks) {
      try {
        callback(observableResult)
      } catch {
        // Silently ignore callback errors to prevent disruption
      }
    }

    return observations
  }
}

/**
 * ObservableUpDownCounter instrument for asynchronous updowncounter observations.
 * @class ObservableUpDownCounter
 * @extends Instrument
 */
class ObservableUpDownCounter extends Instrument {
  #callbacks

  constructor (name, options, instrumentationScope, reader) {
    super(name, options, instrumentationScope, reader)
    this.#callbacks = []
  }

  addCallback (callback) {
    if (typeof callback === 'function') {
      this.#callbacks.push(callback)
      if (this.reader) {
        this.reader.registerObservableInstrument(this)
      }
    }
  }

  removeCallback (callback) {
    const index = this.#callbacks.indexOf(callback)
    if (index !== -1) {
      this.#callbacks.splice(index, 1)
    }
  }

  collect () {
    const observations = []
    const observableResult = {
      observe: (value, attributes = {}) => {
        observations.push({
          name: this.name,
          description: this.description,
          unit: this.unit,
          type: 'observable-updowncounter',
          instrumentationScope: this.instrumentationScope,
          value,
          attributes: sanitizeAttributes(attributes),
          timestamp: Number(process.hrtime.bigint())
        })
      }
    }

    for (const callback of this.#callbacks) {
      try {
        callback(observableResult)
      } catch {
        // Silently ignore callback errors to prevent disruption
      }
    }

    return observations
  }
}

module.exports = {
  Counter,
  UpDownCounter,
  Histogram,
  Gauge,
  ObservableGauge,
  ObservableCounter,
  ObservableUpDownCounter
}
