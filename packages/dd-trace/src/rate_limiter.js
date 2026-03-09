'use strict'

const limiter = require('../../../vendor/dist/limiter')

class RateLimiter {
  #rateLimit
  #limiter
  #tokensRequested = 0
  #prevIntervalTokens = 0
  #prevTokensRequested = 0

  /**
   * @param {number} rateLimit - Allowed units per interval. Negative means unlimited, 0 disables.
   * @param {'second'|'minute'|'hour'|'day'} [interval='second'] - Time window for the limiter.
   */
  constructor (rateLimit, interval = 'second') {
    this.#rateLimit = Number.parseInt(String(rateLimit))
    // The limiter constructor accepts a token count number and an interval string
    this.#limiter = new limiter.RateLimiter(this.#rateLimit, interval)
  }

  /**
   * Maximum allowed units per interval.
   * Used by SamplingRule to expose the configured rate via its maxPerSecond getter.
   * @returns {number}
   */
  get rateLimit () {
    return this.#rateLimit
  }

  /**
   * Attempts to consume a token and reports whether it was allowed.
   * Updates internal counters used for effective rate computation.
   *
   * @returns {boolean}
   */
  isAllowed () {
    const curIntervalStart = this.#limiter.curIntervalStart
    const curIntervalTokens = this.#limiter.tokensThisInterval
    const allowed = this._isAllowed()

    if (curIntervalStart === this.#limiter.curIntervalStart) {
      this.#tokensRequested++
    } else {
      this.#prevIntervalTokens = curIntervalTokens
      this.#prevTokensRequested = this.#tokensRequested
      this.#tokensRequested = 1
    }

    return allowed
  }

  /**
   * Returns the fraction of allowed requests over requested ones in the
   * current and previous intervals combined.
   *
   * @returns {number}
   */
  effectiveRate () {
    if (this.#rateLimit < 0) return 1
    if (this.#rateLimit === 0) return 0
    if (this.#tokensRequested === 0) return 1

    const allowed = this.#prevIntervalTokens + this.#limiter.tokensThisInterval
    const requested = this.#prevTokensRequested + this.#tokensRequested

    return allowed / requested
  }

  /**
   * Internal token consumption without counter side-effects.
   * @returns {boolean}
   */
  _isAllowed () {
    if (this.#rateLimit < 0) return true
    if (this.#rateLimit === 0) return false

    return this.#limiter.tryRemoveTokens(1)
  }

  /**
   * Effective rate within the current interval only.
   * @returns {number}
   */
  _currentWindowRate () {
    if (this.#rateLimit < 0) return 1
    if (this.#rateLimit === 0) return 0
    if (this.#tokensRequested === 0) return 1

    return this.#limiter.tokensThisInterval / this.#tokensRequested
  }
}

module.exports = RateLimiter
