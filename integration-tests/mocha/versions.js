'use strict'

const semver = require('semver')

const latestBeforeMocha11 = '10'
const latestBeforeMocha12 = '11'
// Mocha 11 requires Node.js ^18.18.0, ^20.9.0, or >=21.1.0.
const mocha11NodeRange = '^18.18.0 || ^20.9.0 || >=21.1.0'
// Mocha 12 requires Node.js ^20.19.0 or >=22.12.0.
const mocha12NodeRange = '^20.19.0 || >=22.12.0'

/**
 * @param {string} [nodeVersion]
 * @returns {string}
 */
function getLatestMochaSpecifier (nodeVersion = process.version) {
  if (semver.satisfies(nodeVersion, mocha12NodeRange)) return 'latest'
  if (semver.satisfies(nodeVersion, mocha11NodeRange)) return latestBeforeMocha12
  return latestBeforeMocha11
}

module.exports = {
  getLatestMochaSpecifier,
  latestBeforeMocha11,
  latestBeforeMocha12,
}
