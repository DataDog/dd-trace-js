'use strict'

const Piscina = require('piscina')
const { resolve } = require('path')

class Encoder extends Piscina {
  constructor () {
    super({
      filename: resolve(__dirname, 'pprof-worker.js')
    })
  }

  encode (profile) {
    return this.run(profile)
  }
}

module.exports = { Encoder }