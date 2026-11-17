'use strict'

const oldest = '9.0.0'
const latest = require('../../packages/dd-trace/test/plugins/versions/package.json')
  .dependencies.webdriverio

/**
 * @param {string} [selector]
 */
function getWebdriverioVersions (selector) {
  return selector ? [selector === 'oldest' ? oldest : selector] : [oldest, 'latest']
}

/**
 * @param {string} selector
 */
function resolveWebdriverioVersion (selector) {
  return selector === 'latest' ? latest : selector
}

module.exports = {
  getWebdriverioVersions,
  latest,
  oldest,
  resolveWebdriverioVersion,
}
