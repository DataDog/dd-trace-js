'use strict'

class RateLimiter {
  constructor (rateLimit) {
    this._rateLimit = rateLimit
    this._prevTokensAllowed = 0
    this._prevTokensRequested = 0
    this._tokensRequested = 0
    this._tokensAllowed = 0
    this._timer = undefined
  }

  isAllowed () {
    if (this._rateLimit < 0) return true
    if (this._rateLimit === 0) return false

    if (!this._timer) {
      this._prevTokensAllowed = this._tokensAllowed
      this._prevTokensRequested = this._tokensRequested
      this._tokensAllowed = 0
      this._tokensRequested = 0
      this._timer = setTimeout(() => {
        this._timer = clearTimeout(this._timer)
      }, 1000).unref()
    }

    this._tokensRequested++

    if (this._tokensRequested > this._rateLimit) {
      return false
    } else {
      this._tokensAllowed++
      return true
    }
  }

  effectiveRate () {
    if (this._rateLimit < 0) return 1
    if (this._rateLimit === 0) return 0
    if (this._tokensRequested === 0) return 1

    const allowed = this._prevTokensAllowed + this._tokensAllowed
    const requested = this._prevTokensRequested + this._tokensRequested

    return allowed / requested
  }
}

module.exports = { RateLimiter }
