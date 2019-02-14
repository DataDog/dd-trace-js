'use strict'

const Uint64BE = require('int64-buffer').Uint64BE

Uint64BE.prototype.toJSON = function toJSON () {
  return this.toString()
}

module.exports = Uint64BE
