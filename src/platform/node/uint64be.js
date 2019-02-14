'use strict'

const Uint64BEBase = require('int64-buffer').Uint64BE

class Uint64BE extends Uint64BEBase {
  toJSON () {
    return this.toString()
  }
}

module.exports = Uint64BE
