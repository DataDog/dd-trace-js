'use strict'

const cypressPlugin = require('./cypress-plugin')
const { shouldDeferLegacyFinalization } = require('./finalization')

module.exports = function afterRun () {
  if (shouldDeferLegacyFinalization()) return
  return cypressPlugin.afterRun.apply(cypressPlugin, arguments)
}
