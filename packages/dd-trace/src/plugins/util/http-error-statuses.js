'use strict'

const log = require('../../log')
const kinds = require('../../../../../ext/kinds')

// True means the status is *not* an error, matching the long-standing `validateStatus`
// contract. Clients error on 4xx by default and on 4xx-5xx under OTel semantics, which unlike
// Datadog treats a client 5xx as an error. The server bound stays open above 599 so synthetic
// proxy statuses (600, 999) keep counting as errors.
const validateServerStatus = code => code < 500
const validateClientStatus = code => code < 400 || code >= 500
const validateClientStatusOtelSemantics = code => code < 400
const statusCodeRangesPattern = /^[1-5]\d{2}(?:-[1-5]\d{2})?(?:,[1-5]\d{2}(?:-[1-5]\d{2})?)*$/
const whitespacePattern = /\s/g
const MAX_HTTP_STATUS_CODE = 599

/**
 * @typedef {object} StatusValidatorConfig
 * @property {(code: number) => boolean} [validateStatus] plugin-level override
 * @property {boolean} [DD_TRACE_OTEL_SEMANTICS_ENABLED]
 * @property {unknown} [DD_TRACE_HTTP_SERVER_ERROR_STATUSES]
 */

/**
 * Resolve the status validator for a plugin: the plugin-level `validateStatus`
 * function if there is one, otherwise the default for the span kind.
 *
 * @param {StatusValidatorConfig} config
 * @param {'server' | 'client'} kind one of `ext/kinds`
 * @returns {(code: number) => boolean}
 */
function getStatusValidator (config, kind) {
  if (typeof config.validateStatus === 'function') {
    return config.validateStatus
  }
  if (Object.hasOwn(config, 'validateStatus')) {
    log.error('Expected `validateStatus` to be a function.')
  }

  if (kind === kinds.SERVER) {
    return getServerStatusValidator(config.DD_TRACE_HTTP_SERVER_ERROR_STATUSES)
  }

  return config.DD_TRACE_OTEL_SEMANTICS_ENABLED ? validateClientStatusOtelSemantics : validateClientStatus
}

function getServerStatusValidator (configuredStatuses) {
  if (configuredStatuses === undefined || configuredStatuses === '500-599') return validateServerStatus
  if (typeof configuredStatuses !== 'string') {
    log.error('Expected `DD_TRACE_HTTP_SERVER_ERROR_STATUSES` to be a string.')
    return validateServerStatus
  }

  const normalized = configuredStatuses.replaceAll(whitespacePattern, '')
  if (normalized === '500-599') return validateServerStatus
  if (!statusCodeRangesPattern.test(normalized)) {
    log.error(
      '`DD_TRACE_HTTP_SERVER_ERROR_STATUSES` must contain comma-separated status codes or ranges from 100 to 599.'
    )
    return validateServerStatus
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
    errorStatusCodes.fill(1, Math.min(first, second), Math.max(first, second) + 1)
  }

  return code => errorStatusCodes[code] !== 1
}

module.exports = {
  getStatusValidator,
}
