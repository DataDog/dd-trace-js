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

/**
 * Runs `attempt`, returning its value. On failure, logs and returns `fallback` instead of
 * throwing — this runs inside the caller's promise chain, so a bad payload must not break them.
 *
 * @template T
 * @param {() => T} attempt
 * @param {T} fallback
 * @param {string} logMessage printf-style, with a single %s for the error message
 * @returns {T}
 */
function decode (attempt, fallback, logMessage) {
  try {
    return attempt()
  } catch (error) {
    log.error(logMessage, error.message)
    return fallback
  }
}

module.exports = {
  FILE_FALLBACK,
  IMAGE_FALLBACK,
  stringifyIfNeeded,
  stringifyOrEmpty,
  decode,
}
