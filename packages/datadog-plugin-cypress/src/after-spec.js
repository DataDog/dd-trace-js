'use strict'

const cypressPlugin = require('./cypress-plugin')
const { shouldDeferLegacyFinalization } = require('./finalization')

module.exports = function afterSpec () {
  if (shouldDeferLegacyFinalization()) return
  return cypressPlugin.afterSpec.apply(cypressPlugin, arguments)
}
