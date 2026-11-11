'use strict'

const { DD_MAJOR } = require('../../version')

module.exports = { oldest: DD_MAJOR >= 6 ? '28.0.0' : '24.8.0' }
