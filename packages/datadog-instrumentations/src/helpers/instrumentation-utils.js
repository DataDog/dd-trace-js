'use strict'

const { builtinModules } = require('node:module')

const satisfies = require('../../../../vendor/dist/semifies')
const { getValueFromEnvSources } = require('../../../dd-trace/src/config/helper')
const { isRelativeRequire } = require('./shared-utils')

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage (error) {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'Unknown error'
  }
}

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
 * @param {string} name
 * @param {string|undefined} version
 * @param {string} moduleName
 * @param {{ file?: string, filePattern?: string, versions?: string[] }} instrumentation
 * @returns {boolean}
 */
function matchesInstrumentation (name, version, moduleName, instrumentation) {
  const { file, filePattern, versions } = instrumentation
  let matchesFile = moduleName === filename(name, file)
  if (!matchesFile && isRelativeRequire(name)) matchesFile = true
  if (!matchesFile && filePattern) {
    matchesFile = new RegExp(filename(name, filePattern)).test(moduleName)
  }
  return matchesFile && matchVersion(version, versions)
}

/**
 * @returns {Set<string>}
 */
function getDisabledInstrumentations () {
  const disabled = new Set(
    getValueFromEnvSources('DD_TRACE_DISABLED_INSTRUMENTATIONS')?.split(',').filter(Boolean)
  )
  if (disabled.size === 0) return disabled

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
  errorMessage,
  filename,
  getDisabledInstrumentations,
  matchesInstrumentation,
  matchVersion,
}
