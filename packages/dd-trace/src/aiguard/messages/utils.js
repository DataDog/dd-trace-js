'use strict'

const FILE_FALLBACK = '[file]'
const IMAGE_FALLBACK = '[image]'

/**
 * @param {unknown} value
 * @returns {string|undefined|null}
 */
function stringifyIfNeeded (value) {
  if (value == null) return value
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringifyOrEmpty (value) {
  return stringifyIfNeeded(value) ?? ''
}

module.exports = {
  FILE_FALLBACK,
  IMAGE_FALLBACK,
  stringifyIfNeeded,
  stringifyOrEmpty,
}
