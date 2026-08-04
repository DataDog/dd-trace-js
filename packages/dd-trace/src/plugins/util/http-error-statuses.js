'use strict'

const log = require('../../log')
const kinds = require('../../../../../ext/kinds')

// A validator returns true when the status code is *not* an error, matching the
// `validateStatus` contract plugins have always used.
//
// Server spans error on 5xx regardless of the flag. Client spans error on 4xx by
// default, and on 4xx-5xx when OTel semantics are enabled, since OTel treats a
// client 5xx as an error and Datadog historically did not.
//
// The server bound is open above 599 on purpose: a synthetic status some proxies
// report (600, 999) counted as an error before and still does.
const validateServerStatus = code => code < 500
const validateClientStatus = code => code < 400 || code >= 500
const validateClientStatusOtelSemantics = code => code < 400

/**
 * @typedef {object} StatusValidatorConfig
 * @property {(code: number) => boolean} [validateStatus] plugin-level override
 * @property {boolean} [DD_TRACE_OTEL_SEMANTICS_ENABLED]
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
    return validateServerStatus
  }

  return config.DD_TRACE_OTEL_SEMANTICS_ENABLED ? validateClientStatusOtelSemantics : validateClientStatus
}

module.exports = {
  getStatusValidator,
}
