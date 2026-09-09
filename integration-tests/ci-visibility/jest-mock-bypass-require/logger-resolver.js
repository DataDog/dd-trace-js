'use strict'

const path = require('node:path')

/**
 * @param {string} request
 * @param {{ defaultResolver: (request: string, options: object) => string }} options
 * @returns {string}
 */
module.exports = function loggerResolver (request, options) {
  if (request === process.env.TEST_LOGGER) {
    return path.join(__dirname, 'mapped-logger.js')
  }
  return options.defaultResolver(request, options)
}
