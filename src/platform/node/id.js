'use strict'

const Uint64BE = require('int64-buffer').Uint64BE
const randomBytes = require('crypto').randomBytes

module.exports = () => new Uint64BE(randomBytes(8))
