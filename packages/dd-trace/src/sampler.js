'use strict'

class Sampler {
  /**
   * @param rate {number}
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
   * @returns {boolean}
   */
  isSampled () {
    return this._rate === 1 || Math.random() < this._rate
  }
}

module.exports = Sampler
