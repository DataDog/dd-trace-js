'use strict'

// Maximum trace ID value is the maximum value for a 64-bit unsigned integer.
// Javascript cannot handle such large numbers, we will loose precision but it's fine
// as it is cast into a float64 when computing the threshold
const MAX_TRACE_ID = 2 ** 64 - 1

// Knuth's factor for the sampling algorithm
const SAMPLING_KNUTH_FACTOR = 1111111111111111111n

class Sampler {
  /**
   * @param rate {number}
   */
  constructor (rate) {
    this._rate = rate
    this._threshold = BigInt(Math.floor(rate * MAX_TRACE_ID))
  }

  /**
   * @returns {number}
   */
  rate () {
    return this._rate
  }

  /**
   * @returns {boolean}
   */
  isSampled () {
    if (this._rate === 1) {
      return true
    }

    if (this._rate === 0) {
      return false
    }

    return Math.random() < this._rate
  }
}

module.exports = Sampler
