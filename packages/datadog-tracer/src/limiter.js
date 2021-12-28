'use strict'

class RateLimiter {
  constructor (rateLimit) {
    this._rateLimit = rateLimit
    this._tokensRequested = 0
    this._prevIntervalTokens = 0
    this._prevTokensRequested = 0
    this._limiter = undefined

    if (rateLimit > 0) {
      const limiter = require('limiter') // not always needed so lazy loaded

      this._limiter = new limiter.RateLimiter(this._rateLimit, 'second')
    }
  }

  isAllowed () {
    if (this._rateLimit < 0) return true
    if (this._rateLimit === 0) return false

    const curIntervalStart = this._limiter.curIntervalStart
    const curIntervalTokens = this._limiter.tokensThisInterval
    const allowed = this._limiter.tryRemoveTokens(1)

    if (curIntervalStart !== this._limiter.curIntervalStart) {
      this._prevIntervalTokens = curIntervalTokens
      this._prevTokensRequested = this._tokensRequested
      this._tokensRequested = 1
    } else {
      this._tokensRequested++
    }

    return allowed
  }

  effectiveRate () {
    if (this._rateLimit < 0) return 1
    if (this._rateLimit === 0) return 0
    if (this._tokensRequested === 0) return 1

    const allowed = this._prevIntervalTokens + this._limiter.tokensThisInterval
    const requested = this._prevTokensRequested + this._tokensRequested

    return allowed / requested
  }
}

module.exports = { RateLimiter }
