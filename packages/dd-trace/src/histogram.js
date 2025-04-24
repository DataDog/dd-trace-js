'use strict'

const { DDSketch } = require('@datadog/sketches-js')

class Histogram {
  constructor () {
    this.reset()
  }

  get min () { return this._sketch.count === 0 ? 0 : this._sketch.min }
  get max () { return this._sketch.count === 0 ? 0 : this._sketch.max }
  get avg () { return this._sketch.count === 0 ? 0 : this._sketch.sum / this._sketch.count }
  get sum () { return this._sketch.sum }
  get count () { return this._sketch.count }
  get median () { return this.percentile(50) }
  get p95 () { return this.percentile(95) }

  percentile (percentile) {
    return this._sketch.getValueAtQuantile(percentile / 100) || 0
  }

  merge (histogram) {
    return this._sketch.merge(histogram._sketch)
  }

  record (value) {
    this._sketch.accept(value)
  }

  reset () {
    this._sketch = new DDSketch()
  }
}

module.exports = Histogram
