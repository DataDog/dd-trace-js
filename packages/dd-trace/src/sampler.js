'use strict'

// Maximum trace ID value is the maximum value for a 64-bit unsigned integer.
// Javascript cannot handle such large numbers, we will loose precision but it's fine
// as it is cast into a float64 when computing the threshold
const MAX_TRACE_ID = 2 ** 64 - 1

const UINT64_MODULO = 2n ** 64n

// Knuth's factor for the sampling algorithm
const SAMPLING_KNUTH_FACTOR = 1111111111111111111n

/**
 * `Sampler` determines whether or not to sample a trace/span based on the trace ID.
 *
 * This class uses a deterministic sampling algorithm that is consistent across all languages.
 */
class Sampler {
  /**
   * @param {number} rate
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
   * Determines whether a trace/span should be sampled based on the configured sampling rate.
   *
   * @param {SpanContext} context - The span context to evaluate.
   * @returns {boolean} `true` if the trace/span should be sampled, otherwise `false`.
   */
  isSampled (context) {
    if (this._rate === 1) {
      return true
    }

    if (this._rate === 0) {
      return false
    }

    return (context.toTraceIdBigInt() * SAMPLING_KNUTH_FACTOR) % UINT64_MODULO <= this._threshold
  }
}

module.exports = Sampler
