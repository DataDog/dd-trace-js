'use strict'

const { sanitizeAttributes } = require('@opentelemetry/core')
const { METRIC_TYPES } = require('./constants')

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
  #baseMetadata

  constructor (name, options, instrumentationScope, reader) {
    this.name = name
    this.description = options.description || ''
    this.unit = options.unit || ''
    this.instrumentationScope = instrumentationScope
    this.reader = reader
    // Pre-create static measurement fields to avoid object creation on every measurement
    this.#baseMetadata = {
      name: this.name,
      description: this.description,
      unit: this.unit,
      instrumentationScope: this.instrumentationScope
    }
  }

  createMeasurement (type, value, attributes) {
    return {
      ...this.#baseMetadata,
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
    this.reader.record(this.createMeasurement(METRIC_TYPES.COUNTER, value, attributes))
  }
}

class UpDownCounter extends Instrument {
  add (value, attributes = {}) {
    if (!this.reader) return
    this.reader.record(this.createMeasurement(METRIC_TYPES.UPDOWNCOUNTER, value, attributes))
  }
}

class Histogram extends Instrument {
  record (value, attributes = {}) {
    if (!this.reader || value < 0) return
    this.reader.record(this.createMeasurement(METRIC_TYPES.HISTOGRAM, value, attributes))
  }
}

class Gauge extends Instrument {
  record (value, attributes = {}) {
    if (!this.reader) return
    this.reader.record(this.createMeasurement(METRIC_TYPES.GAUGE, value, attributes))
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
        observations.push(this.createMeasurement(this.#type, value, attributes))
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
    super(name, options, instrumentationScope, reader, METRIC_TYPES.GAUGE)
  }
}

class ObservableCounter extends ObservableInstrument {
  constructor (name, options, instrumentationScope, reader) {
    super(name, options, instrumentationScope, reader, METRIC_TYPES.OBSERVABLECOUNTER)
  }
}

class ObservableUpDownCounter extends ObservableInstrument {
  constructor (name, options, instrumentationScope, reader) {
    super(name, options, instrumentationScope, reader, METRIC_TYPES.OBSERVABLEUPDOWNCOUNTER)
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
