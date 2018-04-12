'use strict'

const Uint64BE = require('int64-buffer').Uint64BE
const crypto = window.crypto || window.msCrypto;

const buffer = new Uint32Array(2);
module.exports = () => {
  crypto.getRandomValues(buffer);
  return new Uint64BE(buffer[0] | buffer[1] << 32)
}
