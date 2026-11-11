'use strict'

const { NODE_MAJOR } = require('../../version')

/**
 * @param {number} [nodeMajor]
 */
function isLatestCucumberSupported (nodeMajor = NODE_MAJOR) {
  return nodeMajor === 22 || nodeMajor === 24 || nodeMajor >= 26
}

module.exports = { isLatestCucumberSupported }
