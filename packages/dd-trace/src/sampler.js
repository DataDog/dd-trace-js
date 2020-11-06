'use strict'

const Config = require('./config')

class Sampler {
  constructor () {
    Config.retroOn('update', config => {
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
