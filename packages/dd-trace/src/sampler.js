'use strict'

// Maximum trace ID value is the maximum value for a 64-bit unsigned integer.
// Javascript cannot handle such large numbers, we will loose precision but it's fine
// as it is cast into a float64 when computing the threshold
const MAX_TRACE_ID = 2 ** 64 - 1

const UINT64_MODULO = 2n ** 64n

// Knuth's factor for the sampling algorithm
const SAMPLING_KNUTH_FACTOR = 1_111_111_111_111_111_111n

/**
 * `Sampler` determines whether or not to sample a trace/span based on the trace ID.
 *
 * This class uses a deterministic sampling algorithm that is consistent across all languages.
 */
class Sampler {
  #threshold = 0n

  /**
   * @param {number} rate
   */
  constructor (rate) {
    // TODO: Should this be moved up to the calling parts?
    rate = Math.min(Math.max(rate, 0), 1)
    this._rate = rate
    this.#threshold = BigInt(Math.floor(rate * MAX_TRACE_ID))
  }

  /**
   * @returns {number}
   */
  rate () {
    return this._rate
  }

  get threshold () {
    return this.#threshold
  }

  /**
   * Determines whether a trace/span should be sampled based on the configured sampling rate.
   *
   * @param {Span|SpanContext} span - The span or span context to evaluate.
   * @returns {boolean} `true` if the trace/span should be sampled, otherwise `false`.
   */
  isSampled (span) {
    if (this._rate === 1) {
      return true
    }

    if (this._rate === 0) {
      return false
    }

    span = typeof span.context === 'function' ? span.context() : span

    return (span._traceId.toBigInt() * SAMPLING_KNUTH_FACTOR) % UINT64_MODULO <= this.#threshold
  }
}

module.exports = Sampler
