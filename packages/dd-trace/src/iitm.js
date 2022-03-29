'use strict'

const semver = require('semver')
const logger = require('./log')

if (semver.satisfies(process.versions.node, '^12.20.0 || >=14.13.1')) {
  module.exports = require('import-in-the-middle')
} else {
  logger.warn('ESM is not fully supported by this version of Node.js, ' +
    'so dd-trace will not intercept ESM loading.')
  module.exports = () => ({
    unhook: () => {}
  })
  module.exports.addHook = () => {}
  module.exports.removeHook = () => {}
}
