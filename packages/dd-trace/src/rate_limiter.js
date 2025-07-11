'use strict'

const limiter = require('limiter')

class RateLimiter {
  constructor (rateLimit, interval = 'second') {
    this._rateLimit = Number.parseInt(rateLimit)
    this._limiter = new limiter.RateLimiter({ tokensPerInterval: this._rateLimit, interval })
    this._tokensRequested = 0
    this._prevIntervalTokens = 0
    this._prevTokensRequested = 0
  }

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

  effectiveRate () {
    if (this._rateLimit < 0) return 1
    if (this._rateLimit === 0) return 0
    if (this._tokensRequested === 0) return 1

    const allowed = this._prevIntervalTokens + this._limiter.tokensThisInterval
    const requested = this._prevTokensRequested + this._tokensRequested

    return allowed / requested
  }

  _isAllowed () {
    if (this._rateLimit < 0) return true
    if (this._rateLimit === 0) return false

    return this._limiter.tryRemoveTokens(1)
  }

  _currentWindowRate () {
    if (this._rateLimit < 0) return 1
    if (this._rateLimit === 0) return 0
    if (this._tokensRequested === 0) return 1

    return this._limiter.tokensThisInterval / this._tokensRequested
  }
}

module.exports = RateLimiter
