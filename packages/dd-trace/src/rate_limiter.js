'use strict'

const limiter = require('limiter')

class RateLimiter {
  constructor (rateLimit) {
    this._rateLimit = parseInt(rateLimit)
    this._limiter = new limiter.RateLimiter(this._rateLimit, 'second')
    this._tokensRequested = 0
    this._prevWindowRate = null
  }

  isAllowed () {
    const curIntervalStart = this._limiter.curIntervalStart
    const allowed = this._isAllowed()

    if (curIntervalStart !== this._limiter.curIntervalStart) {
      this._prevWindowRate = this._currentWindowRate()
      this._tokensRequested = 0
    }

    this._tokensRequested++

    return allowed
  }

  effectiveRate () {
    const currentWindowRate = this._currentWindowRate()

    if (this._prevWindowRate === null) return currentWindowRate

    return (currentWindowRate + this._prevWindowRate) / 2
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
