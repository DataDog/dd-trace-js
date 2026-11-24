'use strict'

const { NODE_MAJOR } = require('../../version')

/**
 * @param {number} [nodeMajor]
 */
function getVitestVersions (nodeMajor = NODE_MAJOR) {
  return nodeMajor <= 18 ? ['1.6.0', '3.2.6'] : ['1.6.0', 'latest']
}

module.exports = { getVitestVersions }
