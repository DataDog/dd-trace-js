'use strict'

class Sampler {
  constructor (rate) {
    this._rate = rate
  }

  isSampled (span) {
    return this._rate === 1 || Math.random() < this._rate
  }
}

module.exports = Sampler
