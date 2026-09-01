'use strict'

const semver = require('semver')

const latestBeforeMocha12 = '11'
// Mocha 12 requires Node.js ^20.19.0 or >=22.12.0.
const mocha12NodeRange = '^20.19.0 || >=22.12.0'

/**
 * @param {string} [nodeVersion]
 * @returns {string}
 */
function getLatestMochaSpecifier (nodeVersion = process.version) {
  return semver.satisfies(nodeVersion, mocha12NodeRange) ? 'latest' : latestBeforeMocha12
}

module.exports = {
  getLatestMochaSpecifier,
  latestBeforeMocha12,
}
