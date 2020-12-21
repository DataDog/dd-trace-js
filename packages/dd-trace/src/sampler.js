'use strict'

const config = require('./config')

class Sampler {
  constructor () {
    config.retroOn('update', () => {
      this._rate = config.sampleRate
    })
  }

  rate () {
    return this._rate
  }

  isSampled () {
    return this._rate === 1 || Math.random() < this._rate
  }
}

module.exports = Sampler
