'use strict'

let DDSketch

class Histogram {
  constructor () {
    if (!DDSketch) {
      DDSketch = require('@datadog/sketches-js').DDSketch
    }

    this.reset()
  }

  get min () { return this._min }
  get max () { return this._max }
  get avg () { return this._count === 0 ? 0 : this._sum / this._count }
  get sum () { return this._sum }
  get count () { return this._count }
  get median () { return this.percentile(50) }
  get p95 () { return this.percentile(95) }

  percentile (percentile) {
    return this._histogram.getValueAtQuantile(percentile / 100) || 0
  }

  record (value) {
    if (this._count === 0) {
      this._min = this._max = value
    } else {
      this._min = Math.min(this._min, value)
      this._max = Math.max(this._max, value)
    }

    this._count++
    this._sum += value

    this._histogram.accept(value)
  }

  reset () {
    this._min = 0
    this._max = 0
    this._sum = 0
    this._count = 0

    this._histogram = new DDSketch()
  }
}

module.exports = Histogram
