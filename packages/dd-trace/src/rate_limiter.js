'use strict'

const limiter = require('limiter')

class RateLimiter {
  /**
   * @param {number} rateLimit - Allowed units per interval. Negative means unlimited, 0 disables.
   * @param {'second'|'minute'|'hour'|'day'} [interval='second'] - Time window for the limiter.
   */
  constructor (rateLimit, interval = 'second') {
    this._rateLimit = Number.parseInt(String(rateLimit))
    // The limiter constructor accepts a token count number and an interval string
    this._limiter = new limiter.RateLimiter(this._rateLimit, interval)
    this._tokensRequested = 0
    this._prevIntervalTokens = 0
    this._prevTokensRequested = 0
  }

  /**
   * Attempts to consume a token and reports whether it was allowed.
   * Updates internal counters used for effective rate computation.
   *
   * @returns {boolean}
   */
  isAllowed () {
    const curIntervalStart = this._limiter.curIntervalStart
    const curIntervalTokens = this._limiter.tokensThisInterval
    const allowed = this._isAllowed()

    if (curIntervalStart === this._limiter.curIntervalStart) {
      this._tokensRequested++
    } else {
      this._prevIntervalTokens = curIntervalTokens
      this._prevTokensRequested = this._tokensRequested
      this._tokensRequested = 1
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
    if (this._rateLimit < 0) return 1
    if (this._rateLimit === 0) return 0
    if (this._tokensRequested === 0) return 1

    const allowed = this._prevIntervalTokens + this._limiter.tokensThisInterval
    const requested = this._prevTokensRequested + this._tokensRequested

    return allowed / requested
  }

  /**
   * Internal token consumption without counter side-effects.
   * @returns {boolean}
   */
  _isAllowed () {
    if (this._rateLimit < 0) return true
    if (this._rateLimit === 0) return false

    return this._limiter.tryRemoveTokens(1)
  }

  /**
   * Effective rate within the current interval only.
   * @returns {number}
   */
  _currentWindowRate () {
    if (this._rateLimit < 0) return 1
    if (this._rateLimit === 0) return 0
    if (this._tokensRequested === 0) return 1

    return this._limiter.tokensThisInterval / this._tokensRequested
  }
}

module.exports = RateLimiter
