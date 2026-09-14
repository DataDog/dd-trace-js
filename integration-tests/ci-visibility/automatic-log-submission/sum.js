'use strict'

const logger = require('./logger')

module.exports = function (a, b) {
  if (process.env.TEST_LOGGER === 'console') {
    logger.error('sum function being called')
  } else {
    logger.info('sum function being called')
  }
  return a + b
}
