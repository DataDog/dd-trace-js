'use strict'

const log = require('../../log')

const statusCodeRangesPattern = /^[1-5]\d{2}(?:-[1-5]\d{2})?(?:,[1-5]\d{2}(?:-[1-5]\d{2})?)*$/
const whitespacePattern = /\s/g
const MAX_HTTP_STATUS_CODE = 599

const SERVER_ERROR_STATUSES = 'DD_TRACE_HTTP_SERVER_ERROR_STATUSES'
const CLIENT_ERROR_STATUSES = 'DD_TRACE_HTTP_CLIENT_ERROR_STATUSES'
const SERVER_ERROR_STATUSES_ORIGIN = 'DD_TRACE_HTTP_SERVER_ERROR_STATUSES_ORIGIN'
const CLIENT_ERROR_STATUSES_ORIGIN = 'DD_TRACE_HTTP_CLIENT_ERROR_STATUSES_ORIGIN'
/** @typedef {(code: number) => boolean} StatusValidator */

/** @type {StatusValidator} */
function isNotServerErrorCode (code) {
  return code < 500
}

/** @type {StatusValidator} */
function isNotClientErrorCode (code) {
  return code < 400 || code >= 500
}

// Under OTel semantics a client 5xx is an error, unlike the Datadog default, and so is any code
// above the range: the conventions treat a code the client could not interpret as a 5xx.
/** @type {StatusValidator} */
function isNotOtelClientErrorCode (code) {
  return code < 400
}

/**
 * @param {{
 *   validateStatus?: unknown,
 *   DD_TRACE_HTTP_SERVER_ERROR_STATUSES?: unknown,
 *   DD_TRACE_HTTP_SERVER_ERROR_STATUSES_ORIGIN?: unknown,
 * }} config
 * @returns {StatusValidator}
 */
function getServerStatusValidator (config) {
  return getStatusValidator(config, SERVER_ERROR_STATUSES, isNotServerErrorCode, SERVER_ERROR_STATUSES_ORIGIN)
}

/**
 * @param {{
 *   validateStatus?: unknown,
 *   DD_TRACE_HTTP_CLIENT_ERROR_STATUSES?: unknown,
 *   DD_TRACE_HTTP_CLIENT_ERROR_STATUSES_ORIGIN?: unknown,
 *   DD_TRACE_OTEL_SEMANTICS_ENABLED?: unknown
 * }} config
 * @returns {StatusValidator}
 */
function getClientStatusValidator (config) {
  if (config.DD_TRACE_OTEL_SEMANTICS_ENABLED) {
    return getStatusValidator(config, CLIENT_ERROR_STATUSES, isNotOtelClientErrorCode, CLIENT_ERROR_STATUSES_ORIGIN)
  }

  return getStatusValidator(config, CLIENT_ERROR_STATUSES, isNotClientErrorCode)
}

/**
 * @param {Record<string, unknown>} config
 * @param {string} optionName - Name of the configuration holding the error status ranges.
 * @param {StatusValidator} defaultValidator
 * @param {string} [originName] - Name of the configuration holding the option origin.
 * @returns {StatusValidator}
 */
function getStatusValidator (config, optionName, defaultValidator, originName) {
  if (typeof config.validateStatus === 'function') {
    return /** @type {StatusValidator} */ (config.validateStatus)
  } else if (Object.hasOwn(config, 'validateStatus')) {
    log.error('Expected `validateStatus` to be a function.')
  }

  const ranges = originName && config[originName] === 'default' ? undefined : config[optionName]
  if (ranges === undefined) return defaultValidator
  if (typeof ranges !== 'string') {
    log.error('Expected `%s` to be a string.', optionName)
    return defaultValidator
  }
  const normalized = ranges.replaceAll(whitespacePattern, '')
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
