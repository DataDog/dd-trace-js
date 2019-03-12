'use strict'

const crypto = require('crypto')

module.exports = (size) => crypto.randomBytes(16).slice(0, size).toString('hex')
