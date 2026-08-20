'use strict'

const log = require('../../log')

const statusCodeRangesPattern = /^[1-5]\d{2}(?:-[1-5]\d{2})?(?:,[1-5]\d{2}(?:-[1-5]\d{2})?)*$/
const whitespacePattern = /\s/g
const MAX_HTTP_STATUS_CODE = 599

const SERVER_ERROR_STATUSES = 'DD_TRACE_HTTP_SERVER_ERROR_STATUSES'
const CLIENT_ERROR_STATUSES = 'DD_TRACE_HTTP_CLIENT_ERROR_STATUSES'

/** @typedef {(code: number) => boolean} StatusValidator */

/** @type {StatusValidator} */
function isNotServerErrorCode (code) {
  return code < 500
}

/** @type {StatusValidator} */
function isNotClientErrorCode (code) {
  return code < 400 || code >= 500
}

/**
 * @param {{ validateStatus?: unknown, DD_TRACE_HTTP_SERVER_ERROR_STATUSES?: unknown }} config
 * @returns {StatusValidator}
 */
function getServerStatusValidator (config) {
  return getStatusValidator(config, SERVER_ERROR_STATUSES, '500-599', isNotServerErrorCode)
}

/**
 * @param {{ validateStatus?: unknown, DD_TRACE_HTTP_CLIENT_ERROR_STATUSES?: unknown }} config
 * @returns {StatusValidator}
 */
function getClientStatusValidator (config) {
  return getStatusValidator(config, CLIENT_ERROR_STATUSES, '400-499', isNotClientErrorCode)
}

/**
 * @param {Record<string, unknown>} config
 * @param {string} optionName - Name of the configuration holding the error status ranges.
 * @param {string} defaultRanges - Ranges covered by `defaultValidator`
 * @param {StatusValidator} defaultValidator
 * @returns {StatusValidator}
 */
function getStatusValidator (config, optionName, defaultRanges, defaultValidator) {
  if (typeof config.validateStatus === 'function') {
    return /** @type {StatusValidator} */ (config.validateStatus)
  } else if (Object.hasOwn(config, 'validateStatus')) {
    log.error('Expected `validateStatus` to be a function.')
  }

  const ranges = config[optionName]
  if (ranges === undefined) return defaultValidator
  if (typeof ranges !== 'string') {
    log.error('Expected `%s` to be a string.', optionName)
    return defaultValidator
  }
  if (ranges === defaultRanges) return defaultValidator

  const normalized = ranges.replaceAll(whitespacePattern, '')
  if (normalized === defaultRanges) return defaultValidator
  if (!statusCodeRangesPattern.test(normalized)) {
    log.error('`%s` must contain comma-separated status codes or ranges from 100 to 599.', optionName)
    return defaultValidator
  }

  const errorStatusCodes = new Uint8Array(MAX_HTTP_STATUS_CODE + 1)
  for (const range of normalized.split(',')) {
    const separator = range.indexOf('-')
    if (separator === -1) {
      errorStatusCodes[Number(range)] = 1
      continue
    }

    const first = Number(range.slice(0, separator))
    const second = Number(range.slice(separator + 1))
    const start = Math.min(first, second)
    const end = Math.max(first, second)
    errorStatusCodes.fill(1, start, end + 1)
  }

  /**
   * @param {number} code
   * @returns {boolean}
   */
  function isValidStatusCode (code) {
    return errorStatusCodes[code] !== 1
  }

  return isValidStatusCode
}

module.exports = {
  getClientStatusValidator,
  getServerStatusValidator,
}
