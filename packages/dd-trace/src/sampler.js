'use strict'

const Config = require('./config')

class Sampler {
  constructor () {
    function configure () {
      this._rate = Config.config.sampleRate
    }
    configure.call(this)
    Config.config.on('update', configure.bind(this))
  }

  rate () {
    return this._rate
  }

  isSampled () {
    return this._rate === 1 || Math.random() < this._rate
  }
}

module.exports = Sampler
