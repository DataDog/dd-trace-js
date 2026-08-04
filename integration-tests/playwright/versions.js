'use strict'

const { DD_MAJOR, NODE_MAJOR } = require('../../version')

const oldest = DD_MAJOR >= 6 ? '1.38.0' : '1.18.0'
const latest = require('../../packages/dd-trace/test/plugins/versions/package.json')
  .dependencies['@playwright/test']
const latestSupportedByNode18 = '1.61.0'

/**
 * @param {number} [nodeMajor]
 * @returns {string}
 */
function getLatestPlaywrightSpecifier (nodeMajor = NODE_MAJOR) {
  return nodeMajor < 20 ? latestSupportedByNode18 : 'latest'
}

module.exports = {
  getLatestPlaywrightSpecifier,
  latest,
  latestSupportedByNode18,
  oldest,
}
