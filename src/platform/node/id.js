'use strict'

const Int64BE = require('int64-buffer').Int64BE
const randomBytes = require('crypto').randomBytes

module.exports = () => new Int64BE(randomBytes(8))
