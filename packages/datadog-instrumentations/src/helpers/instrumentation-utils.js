'use strict'

const { builtinModules } = require('node:module')

const satisfies = require('../../../../vendor/dist/semifies')
const { getValueFromEnvSources } = require('../../../dd-trace/src/config/helper')

/**
 * @param {string|undefined} version
 * @param {string[]|undefined} ranges
 * @returns {boolean}
 */
function matchVersion (version, ranges) {
  return !version || !ranges || ranges.some(range => satisfies(version, range))
}

/**
 * @param {string} name
 * @param {string} [file]
 * @returns {string}
 */
function filename (name, file) {
  return file ? `${name}/${file}` : name
}

/**
 * @returns {Set<string>}
 */
function getDisabledInstrumentations () {
  const disabled = new Set(
    getValueFromEnvSources('DD_TRACE_DISABLED_INSTRUMENTATIONS')?.split(',').filter(Boolean)
  )
  const expanded = new Set(disabled)
  const builtins = new Set(builtinModules)

  for (const name of disabled) {
    const prefixed = name.startsWith('node:')
    if (!prefixed && !builtins.has(name)) continue

    const counterpart = prefixed ? name.slice(5) : `node:${name}`
    expanded.add(counterpart)
  }

  return expanded
}

module.exports = {
  filename,
  getDisabledInstrumentations,
  matchVersion,
}
