'use strict'

const log = require('../../log')

// Defaults per the OTel HTTP semantic conventions RFC: server spans error on 5xx
// regardless of the flag, client spans error on 4xx by default and on 4xx-5xx
// when OTel semantics are enabled (OTel treats a client 5xx as an error, Datadog
// historically did not).
const SERVER_DEFAULT = '500-599'
const CLIENT_DEFAULT = '400-499'
const CLIENT_OTEL_DEFAULT = '400-599'

/**
 * Parse a status-code range specification (`"400-499,503"`) into inclusive
 * `[low, high]` pairs. Single codes become a degenerate pair so the matcher only
 * deals with one shape.
 *
 * The config layer has a sibling parser, `transformers.setGRPCRange`, which
 * expands the same syntax into a flat array of codes. HTTP ranges span hundreds
 * of codes, so ranges are kept as bounds here instead of being expanded.
 *
 * @param {string} spec
 * @param {string} optionName name reported when the spec is unusable
 * @returns {Array<[number, number]> | undefined} undefined when nothing parsed
 */
function parseStatusRanges (spec, optionName) {
  const ranges = []

  for (const part of spec.split(',')) {
    const trimmed = part.trim()
    if (trimmed === '') continue

    const dashIndex = trimmed.indexOf('-', 1)
    if (dashIndex === -1) {
      const code = Number(trimmed)
      if (Number.isInteger(code)) ranges.push([code, code])
      continue
    }

    const low = Number(trimmed.slice(0, dashIndex))
    const high = Number(trimmed.slice(dashIndex + 1))
    if (Number.isInteger(low) && Number.isInteger(high) && low <= high) ranges.push([low, high])
  }

  if (ranges.length === 0) {
    log.error('Expected `%s` to be a list of status codes and ranges, got %s', optionName, spec)
    return
  }

  return ranges
}

/**
 * Build the `validateStatus` predicate a plugin calls per response: it returns
 * true when the status code is *not* an error.
 *
 * @param {string} spec
 * @param {string} optionName
 * @returns {(code: number) => boolean}
 */
function buildStatusValidator (spec, optionName) {
  const ranges = parseStatusRanges(spec, optionName)
  if (ranges === undefined) return () => true

  // The single-range case (both defaults, and nearly every user config) compiles
  // to the same two comparisons the hardcoded thresholds used before.
  if (ranges.length === 1) {
    const [low, high] = ranges[0]
    return code => code < low || code > high
  }

  return code => {
    for (const [low, high] of ranges) {
      if (code >= low && code <= high) return false
    }
    return true
  }
}

/**
 * @typedef {object} StatusValidatorConfig
 * @property {(code: number) => boolean} [validateStatus] plugin-level override
 * @property {string} [DD_TRACE_HTTP_SERVER_ERROR_STATUSES]
 * @property {string} [DD_TRACE_HTTP_CLIENT_ERROR_STATUSES]
 * @property {boolean} [DD_TRACE_OTEL_SEMANTICS_ENABLED]
 */

/**
 * Resolve the status validator for a plugin, in precedence order: the
 * plugin-level `validateStatus` function, then the tracer configuration, then
 * the default range for the span kind.
 *
 * The configuration deliberately wins over the OTel status rules, so a user who
 * sets an explicit range keeps it with the flag on.
 *
 * @param {StatusValidatorConfig} config
 * @param {'server' | 'client'} kind
 * @returns {(code: number) => boolean}
 */
function getStatusValidator (config, kind) {
  if (typeof config.validateStatus === 'function') {
    return config.validateStatus
  }
  if (Object.hasOwn(config, 'validateStatus')) {
    log.error('Expected `validateStatus` to be a function.')
  }

  if (kind === 'server') {
    const optionName = 'DD_TRACE_HTTP_SERVER_ERROR_STATUSES'
    return buildStatusValidator(config[optionName] ?? SERVER_DEFAULT, optionName)
  }

  const optionName = 'DD_TRACE_HTTP_CLIENT_ERROR_STATUSES'
  const configured = config[optionName]
  if (configured !== undefined) return buildStatusValidator(configured, optionName)

  return buildStatusValidator(
    config.DD_TRACE_OTEL_SEMANTICS_ENABLED ? CLIENT_OTEL_DEFAULT : CLIENT_DEFAULT,
    optionName
  )
}

module.exports = {
  getStatusValidator,
  parseStatusRanges, // exercised directly by the helper spec
}
