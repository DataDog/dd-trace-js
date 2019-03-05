'use strict'

const crypto = require('crypto')

module.exports = () => crypto.randomBytes(8).toString('hex')
