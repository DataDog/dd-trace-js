'use strict'

const logger = require('./logger')

module.exports = function (a, b) {
  logger.log('info', 'sum function being called')
  return a + b
}
