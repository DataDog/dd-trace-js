'use strict'

/**
 * @typedef {object} SourceLocation
 * @property {string | null | undefined} file
 * @property {number | null | undefined} line
 * @property {number | null | undefined} column
 */
/** @type {import('./file-system').DirectFileSystem | undefined} */
let directFileSystem

/**
 * @template Value
 * @param {Value} value
 * @returns {Value}
 */
function identity (value) {
  return value
}

/**
 * @param {'off' | 'datadog' | 'all'} mode
 */
function configure (mode) {
  if (mode === 'datadog') {
    directFileSystem ??= require('./file-system')()
    remap.errorStack = loadAndRemapErrorStack
    remap.location = loadAndRemapSourceLocation
  } else if (mode === 'all') {
    require('./index').configure(mode)
  } else {
    remap.errorStack = identity
    remap.location = identity
  }
}

/**
 * @param {unknown} stack
 * @returns {unknown}
 */
function loadAndRemapErrorStack (stack) {
  require('./index').configure('datadog', directFileSystem)
  if (remap.errorStack === loadAndRemapErrorStack) {
    remap.errorStack = identity
    remap.location = identity
  }
  return remap.errorStack(stack)
}

/**
 * @param {SourceLocation} location
 * @returns {SourceLocation}
 */
function loadAndRemapSourceLocation (location) {
  require('./index').configure('datadog', directFileSystem)
  if (remap.location === loadAndRemapSourceLocation) {
    remap.errorStack = identity
    remap.location = identity
  }
  return remap.location(location)
}

/**
 * @type {{
 *   configure: (mode: 'off' | 'datadog' | 'all') => void,
 *   errorStack: (stack: unknown) => unknown,
 *   location: (location: SourceLocation) => SourceLocation
 * }}
 */
const remap = module.exports = {
  configure,
  errorStack: identity,
  location: identity,
}
