'use strict'

const KNUTH_FACTOR = 1111111111111111111
const MAX_TRACE_ID = 2**64-1

class Sampler {
  /**
   * @param rate {number}
   */
  constructor (rate) {
    this._rate = rate
    this._sampling_id_threshold = MAX_TRACE_ID * rate
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
  isSampled (context) {
      return this._rate === 1 ||
          ((context.toTraceIdNumber(false) * KNUTH_FACTOR) % MAX_TRACE_ID) <= this._sampling_id_threshold
  }
}

module.exports = Sampler
