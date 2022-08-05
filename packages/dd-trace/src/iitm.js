'use strict'

const semver = require('semver')
const logger = require('./log')
const { moduleLoadStart } = require('./channel-itm')

if (semver.satisfies(process.versions.node, '>=14.13.1')) {
  const iitm = require('import-in-the-middle/lib/register.js')
  const originalRegister = iitm.register
  const newRegister = function (name, namespace, set, specifier) {
    if (moduleLoadStart.hasSubscribers) {
      moduleLoadStart.publish({
        filename: name,
        module: namespace,
        request: specifier
      })
    }
    return originalRegister.apply(this, arguments)
  }
  iitm.register = newRegister
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
