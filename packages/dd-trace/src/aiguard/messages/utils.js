'use strict'

const log = require('../../log')

const FILE_FALLBACK = '[file]'
const IMAGE_FALLBACK = '[image]'

/**
 * @param {unknown} value
 * @returns {string|undefined|null}
 */
function stringifyIfNeeded (value) {
  if (value == null) return value
  if (typeof value === 'string') return value

  try {
    return JSON.stringify(value)
  } catch (error) {
    log.debug('AIGuard: dropping an unserializable message field: %s', error.message)
  }
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
