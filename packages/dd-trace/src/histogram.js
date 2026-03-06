'use strict'

const { DDSketch } = require('../../../vendor/dist/@datadog/sketches-js')

class Histogram {
  #sketch

  constructor () {
    this.reset()
  }

  get min () { return this.#sketch.count === 0 ? 0 : this.#sketch.min }
  get max () { return this.#sketch.count === 0 ? 0 : this.#sketch.max }
  get avg () { return this.#sketch.count === 0 ? 0 : this.#sketch.sum / this.#sketch.count }
  get sum () { return this.#sketch.sum }
  get count () { return this.#sketch.count }
  get median () { return this.percentile(50) }
  get p95 () { return this.percentile(95) }

  percentile (percentile) {
    return this.#sketch.getValueAtQuantile(percentile / 100) || 0
  }

  merge (histogram) {
    return this.#sketch.merge(histogram.#sketch)
  }

  record (value) {
    this.#sketch.accept(value)
  }

  reset () {
    this.#sketch = new DDSketch()
  }
}

module.exports = Histogram
