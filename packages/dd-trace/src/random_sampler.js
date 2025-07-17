'use strict'

/**
 * `RandomSampler` determines whether or not to sample an operation based on random chance.
 *
 * Use this class **only** when the operation you are sampling does **not have access**
 * to a `Span` or its `SpanContext`.
 *
 * If a `Span` or its `SpanContext` **is** available, use the `Sampler` class instead as
 * it uses a deterministic sampling algorithm consistent across all languages.
 */
class RandomSampler {
  /**
   * @param {number} rate
   */
  constructor (rate) {
    this._rate = rate
  }

  /**
   * @returns {number}
   */
  rate () {
    return this._rate
  }

  /**
   * Determines whether an operation should be sampled based on the configured sampling rate.
   *
   * Returns `true` if the sampling decision passes (i.e., the operation should be sampled).
   * This happens if the sampling rate is `1` (i.e., always sample) or if a random value falls below the rate.
   *
   * @returns {boolean} `true` if the operation should be sampled, otherwise `false`.
   */
  isSampled () {
    return this._rate === 1 || Math.random() < this._rate
  }
}

module.exports = RandomSampler
