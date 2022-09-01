'use strict'

const semver = require('semver')
const logger = require('./log')
const { addHook } = require('import-in-the-middle')
const dc = require('diagnostics_channel')

if (semver.satisfies(process.versions.node, '>=14.13.1')) {
  const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')
  addHook((name, namespace) => {
    if (moduleLoadStartChannel.hasSubscribers) {
      moduleLoadStartChannel.publish({
        filename: name,
        module: namespace
      })
    }
  })
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
