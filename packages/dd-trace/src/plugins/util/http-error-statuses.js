'use strict'

const log = require('../../log')
const kinds = require('../../../../../ext/kinds')

// Defaults per the OTel HTTP semantic conventions RFC: server spans error on 5xx
// regardless of the flag, client spans error on 4xx by default and on 4xx-5xx
// when OTel semantics are enabled (OTel treats a client 5xx as an error, Datadog
// historically did not).
//
// The server range is open above 599 on purpose. The hardcoded default it replaces
// was `code < 500`, so a synthetic status some proxies report (600, 999) was an
// error; capping at 599 would silently stop marking those.
const SERVER_DEFAULT_RANGES = [[500, Number.POSITIVE_INFINITY]]
const CLIENT_DEFAULT_RANGES = [[400, 499]]
const CLIENT_OTEL_DEFAULT_RANGES = [[400, 599]]

/**
 * Parse a status-code range specification (`"400-499,503"`) into inclusive
 * `[low, high]` pairs. Single codes become a degenerate pair so the matcher only
 * deals with one shape.
 *
 * The config layer has a sibling parser, `transformers.setGRPCRange`, which
 * expands the same syntax into a flat array of codes. HTTP ranges span hundreds
 * of codes, so ranges are kept as bounds here instead of being expanded.
 *
 * Entries that do not parse are dropped and reported, rather than taking the
 * whole spec down with them.
 *
 * @param {string} spec
 * @param {string} optionName name reported when an entry is unusable
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
      if (Number.isInteger(code)) {
        ranges.push([code, code])
      } else {
        log.error('Ignoring `%s` entry %s: not a status code or range.', optionName, trimmed)
      }
      continue
    }

    const low = Number(trimmed.slice(0, dashIndex))
    const high = Number(trimmed.slice(dashIndex + 1))
    if (Number.isInteger(low) && Number.isInteger(high) && low <= high) {
      ranges.push([low, high])
    } else {
      log.error('Ignoring `%s` entry %s: not a status code or range.', optionName, trimmed)
    }
  }

  if (ranges.length === 0) {
    log.error('Expected `%s` to be a list of status codes and ranges, got %s', optionName, spec)
    return
  }

  return ranges
}

/**
 * Compile inclusive `[low, high]` bounds into the `validateStatus` predicate a
 * plugin calls per response: it returns true when the status code is *not* an
 * error.
 *
 * @param {Array<[number, number]>} ranges
 * @returns {(code: number) => boolean}
 */
function validatorFromRanges (ranges) {
  // The single-range case (every default, and nearly every user config) compiles
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
 * Build the validator for a configured spec, falling back to the span kind's
 * default when the spec is unusable. Falling back to the default rather than to
 * "nothing is an error" matters: an empty environment variable (`VAR=`, which is
 * what an unset compose value expands to) would otherwise silently stop every
 * 5xx from being marked.
 *
 * @param {string} spec
 * @param {string} optionName
 * @param {Array<[number, number]>} defaultRanges
 * @returns {(code: number) => boolean}
 */
function buildStatusValidator (spec, optionName, defaultRanges) {
  return validatorFromRanges(parseStatusRanges(spec, optionName) ?? defaultRanges)
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
    const optionName = 'DD_TRACE_HTTP_SERVER_ERROR_STATUSES'
    const configured = config[optionName]
    return configured === undefined
      ? validatorFromRanges(SERVER_DEFAULT_RANGES)
      : buildStatusValidator(configured, optionName, SERVER_DEFAULT_RANGES)
  }

  const optionName = 'DD_TRACE_HTTP_CLIENT_ERROR_STATUSES'
  const defaultRanges = config.DD_TRACE_OTEL_SEMANTICS_ENABLED
    ? CLIENT_OTEL_DEFAULT_RANGES
    : CLIENT_DEFAULT_RANGES
  const configured = config[optionName]

  return configured === undefined
    ? validatorFromRanges(defaultRanges)
    : buildStatusValidator(configured, optionName, defaultRanges)
}

module.exports = {
  getStatusValidator,
  parseStatusRanges, // exercised directly by the helper spec
}
