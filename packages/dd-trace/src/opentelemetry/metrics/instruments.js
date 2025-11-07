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
 * @private
 */
class Instrument {
  constructor (name, options, instrumentationScope, reader) {
    this.name = name
    this.description = options.description ?? ''
    this.unit = options.unit ?? ''
    this.instrumentationScope = instrumentationScope
    this.reader = reader
  }

  createMeasurement = (type, value, attributes) => {
    return {
      name: this.name,
      description: this.description,
      unit: this.unit,
      instrumentationScope: this.instrumentationScope,
      type,
      value,
      attributes: sanitizeAttributes(attributes),
      timestamp: Number(process.hrtime.bigint())
    }
  }
}

/**
 * Implementation of the OpenTelemetry Counter interface:
 * https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_api._opentelemetry_api.Counter.html
 * @class Counter
 */
class Counter extends Instrument {
  add (value, attributes = {}) {
    if (value < 0) return
    this.reader?.record(this.createMeasurement(METRIC_TYPES.COUNTER, value, attributes))
  }
}

/**
 * Implementation of the OpenTelemetry UpDownCounter interface:
 * https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_api._opentelemetry_api.UpDownCounter.html
 * @class UpDownCounter
 */
class UpDownCounter extends Instrument {
  add (value, attributes = {}) {
    this.reader?.record(this.createMeasurement(METRIC_TYPES.UPDOWNCOUNTER, value, attributes))
  }
}

/**
 * Implementation of the OpenTelemetry Histogram interface:
 * https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_api._opentelemetry_api.Histogram.html
 * @class Histogram
 */
class Histogram extends Instrument {
  record (value, attributes = {}) {
    if (value < 0) return
    this.reader?.record(this.createMeasurement(METRIC_TYPES.HISTOGRAM, value, attributes))
  }
}

/**
 * Implementation of the OpenTelemetry Gauge interface:
 * https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_api._opentelemetry_api.Gauge.html
 * @class Gauge
 */
class Gauge extends Instrument {
  record (value, attributes = {}) {
    this.reader?.record(this.createMeasurement(METRIC_TYPES.GAUGE, value, attributes))
  }
}

/**
 * Base class for observable (asynchronous) instruments.
 * Implementation of the OpenTelemetry Observable interface:
 * https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_api._opentelemetry_api.Observable.html
 * @private
 */
class ObservableInstrument extends Instrument {
  #callbacks = []
  #type

  constructor (name, options, instrumentationScope, reader, type) {
    super(name, options, instrumentationScope, reader)
    this.#type = type
  }

  /**
   * Adds a callback to invoke during metric collection.
   *
   * @param {Function} callback - Receives an ObservableResult to record observations
   */
  addCallback (callback) {
    if (typeof callback !== 'function') return
    this.#callbacks.push(callback)
    this.reader?.registerObservableInstrument(this)
  }

  /**
   * Removes a callback.
   *
   * @param {Function} callback - The callback to remove
   */
  removeCallback (callback) {
    const index = this.#callbacks.indexOf(callback)
    if (index !== -1) {
      this.#callbacks.splice(index, 1)
    }
  }

  /**
   * Collects observations from all callbacks. Errors are silently ignored.
   *
   * @returns {Array<Object>} Array of measurements
   */
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

/**
 * Implementation of the OpenTelemetry ObservableGauge interface:
 * https://open-telemetry.github.io/opentelemetry-js/types/_opentelemetry_api._opentelemetry_api.ObservableGauge.html
 * @class ObservableGauge
 */
class ObservableGauge extends ObservableInstrument {
  constructor (name, options, instrumentationScope, reader) {
    super(name, options, instrumentationScope, reader, METRIC_TYPES.GAUGE)
  }
}

/**
 * Implementation of the OpenTelemetry ObservableCounter interface:
 * https://open-telemetry.github.io/opentelemetry-js/types/_opentelemetry_api._opentelemetry_api.ObservableCounter.html
 * @class ObservableCounter
 */
class ObservableCounter extends ObservableInstrument {
  constructor (name, options, instrumentationScope, reader) {
    super(name, options, instrumentationScope, reader, METRIC_TYPES.OBSERVABLECOUNTER)
  }
}

/**
 * Implementation of the OpenTelemetry ObservableUpDownCounter interface:
 * https://open-telemetry.github.io/opentelemetry-js/types/_opentelemetry_api._opentelemetry_api.ObservableUpDownCounter.html
 * @class ObservableUpDownCounter
 */
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
