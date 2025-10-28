'use strict'

const { sanitizeAttributes } = require('@opentelemetry/core')

/**
 * @typedef {import('@opentelemetry/api').Attributes} Attributes
 * @typedef {import('@opentelemetry/core').InstrumentationScope} InstrumentationScope
 */

/**
 * Base class for all metric instruments.
 *
 * This implementation follows the OpenTelemetry JavaScript API Instrument interface:
 * https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_api._opentelemetry_api.Instrument.html
 * @private
 */
class Instrument {
  constructor (name, options, instrumentationScope, reader) {
    this.name = name
    this.description = options.description || ''
    this.unit = options.unit || ''
    this.instrumentationScope = instrumentationScope
    this.reader = reader
    // Pre-create static measurement fields to avoid object creation on every measurement
    this._baseMetadata = {
      name: this.name,
      description: this.description,
      unit: this.unit,
      instrumentationScope: this.instrumentationScope
    }
  }

  _createMeasurement (type, value, attributes) {
    return {
      ...this._baseMetadata,
      type,
      value,
      attributes: sanitizeAttributes(attributes),
      timestamp: Number(process.hrtime.bigint())
    }
  }
}

class Counter extends Instrument {
  add (value, attributes = {}) {
    if (!this.reader || value < 0) return
    this.reader.record(this._createMeasurement('counter', value, attributes))
  }
}

class UpDownCounter extends Instrument {
  add (value, attributes = {}) {
    if (!this.reader) return
    this.reader.record(this._createMeasurement('updowncounter', value, attributes))
  }
}

class Histogram extends Instrument {
  record (value, attributes = {}) {
    if (!this.reader || value < 0) return
    this.reader.record(this._createMeasurement('histogram', value, attributes))
  }
}

class Gauge extends Instrument {
  record (value, attributes = {}) {
    if (!this.reader) return
    this.reader.record(this._createMeasurement('gauge', value, attributes))
  }
}

/**
 * Base class for observable (asynchronous) instruments.
 * @private
 */
class ObservableInstrument extends Instrument {
  #callbacks
  #type

  constructor (name, options, instrumentationScope, reader, type) {
    super(name, options, instrumentationScope, reader)
    this.#callbacks = []
    this.#type = type
  }

  addCallback (callback) {
    if (typeof callback !== 'function') return
    this.#callbacks.push(callback)
    if (this.reader) {
      this.reader.registerObservableInstrument(this)
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
        observations.push(this._createMeasurement(this.#type, value, attributes))
      }
    }

    for (const callback of this.#callbacks) {
      try {
        callback(observableResult)
      } catch {
        // Ignore callback errors per OpenTelemetry spec to prevent disruption
        // Errors are swallowed as callbacks should not break metric collection
      }
    }

    return observations
  }
}

class ObservableGauge extends ObservableInstrument {
  constructor (name, options, instrumentationScope, reader) {
    super(name, options, instrumentationScope, reader, 'gauge')
  }
}

class ObservableCounter extends ObservableInstrument {
  constructor (name, options, instrumentationScope, reader) {
    super(name, options, instrumentationScope, reader, 'observable-counter')
  }
}

class ObservableUpDownCounter extends ObservableInstrument {
  constructor (name, options, instrumentationScope, reader) {
    super(name, options, instrumentationScope, reader, 'observable-updowncounter')
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
