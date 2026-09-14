'use strict'

const { builtinModules } = require('node:module')

const builtinModuleNames = new Set(builtinModules)

/**
 * @param {string | undefined} value
 * @returns {Set<string>}
 */
module.exports = function getDisabledInstrumentations (value) {
  const disabledInstrumentations = new Set(value?.split(','))
  const builtinCounterparts = []

  // Always disable prefixed and unprefixed Node.js modules if either spelling is disabled.
  for (const name of disabledInstrumentations) {
    if (name.startsWith('node:')) {
      builtinCounterparts.push(name.slice(5))
    } else if (builtinModuleNames.has(name)) {
      builtinCounterparts.push(`node:${name}`)
    }
  }
  for (const name of builtinCounterparts) disabledInstrumentations.add(name)

  return disabledInstrumentations
}
