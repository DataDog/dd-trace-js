'use strict'

const log = require('../log')
const telemetryMetrics = require('../telemetry/metrics')

// Fastly answers URLs over 8 KB with 414 URI Too Long: https://docs.fastly.com/products/network-services-resource-limits
const MAX_RULES_URL_BYTES = 8192
const NOT_SENT = 'featureFlags.flagSelection was not sent (%s: %s). Loading the full flag configuration.'
const IGNORED = 'featureFlags.flagSelection was ignored by the server (%s). Loaded the full flag configuration.'
const REMOTE_CONFIG_UNSUPPORTED = 'featureFlags.flagSelection is not supported when flags are delivered through ' +
  'Remote Config. Loading the full flag configuration.'
const MALFORMED_LIMIT = 'featureFlags.flagSelection must be an object with optional tags and keyPatterns string arrays'
const URL_LIMIT = `the request URL is at most ${MAX_RULES_URL_BYTES} bytes`
const IGNORED_REASONS = new Set([
  'malformed_selection',
  'too_many_values',
  'invalid_key_pattern',
  'invalid_tag',
  'tag_load_failed',
])

const tracerMetrics = telemetryMetrics.manager.namespace('tracers')
const countedDroppedReasons = new Set()
const reportedIgnoredReasons = new Set()

/**
 * @typedef {'malformed_selection' | 'too_many_values' | 'invalid_key_pattern' | 'invalid_tag'} DropReason
 * @typedef {{ selection?: { tags: string[], keyPatterns: string[] }, error?: DropReason }} CanonicalizeResult
 */

let flaggingCore

/**
 * @param {unknown} option - Raw `featureFlags.flagSelection` value; must not be null or undefined.
 * @returns {CanonicalizeResult}
 */
function canonicalize (option) {
  flaggingCore ??= require('../../../../vendor/dist/@datadog/flagging-core')
  try {
    return flaggingCore.canonicalizeFlagSelection(option)
  } catch {
    // Only a throwing getter or proxy gets here, which is not an object with tags and keyPatterns arrays.
    return { error: 'malformed_selection' }
  }
}

/**
 * @param {DropReason} reason
 */
function limitDescription (reason) {
  switch (reason) {
    case 'malformed_selection':
      return MALFORMED_LIMIT
    case 'too_many_values':
      return `each list accepts at most ${flaggingCore.MAX_FLAG_SELECTION_VALUES} values`
    case 'invalid_key_pattern':
      return `each key pattern is at most ${flaggingCore.MAX_FLAG_SELECTION_KEY_PATTERN_BYTES} UTF-8 bytes`
    case 'invalid_tag':
      return `each tag is at most ${flaggingCore.MAX_FLAG_SELECTION_TAG_BYTES} UTF-8 bytes`
  }
}

/**
 * @param {DropReason} reason
 * @param {string} limit
 */
function reportDropped (reason, limit) {
  log.error(NOT_SENT, reason, limit)
  if (countedDroppedReasons.has(reason)) return
  countedDroppedReasons.add(reason)
  tracerMetrics.count('flag_selection.dropped', { reason }).inc()
}

/**
 * Percent-encodes everything outside the RFC 3986 unreserved set; `encodeURIComponent` keeps `!'()*`.
 *
 * @param {string} value
 */
function encodeQueryValue (value) {
  return encodeURIComponent(value)
    .replaceAll(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * Adds the canonical selection to the rules endpoint query, or reports why it is not sent.
 *
 * @param {URL} endpoint
 * @param {unknown} option - Raw `featureFlags.flagSelection` value.
 * @returns {URL | undefined} The endpoint with the selection, or undefined when no selection is sent.
 */
function withFlagSelection (endpoint, option) {
  if (option === undefined || option === null) return

  const { selection, error } = canonicalize(option)
  if (error) {
    reportDropped(error, limitDescription(error))
    return
  }
  if (!selection) return

  const parameters = [
    ...selection.tags.map(tag => `selected_flag_tags=${encodeQueryValue(tag)}`),
    ...selection.keyPatterns.map(pattern => `selected_flag_key_patterns=${encodeQueryValue(pattern)}`),
  ].join('&')
  const url = new URL(endpoint)
  const query = url.search.slice(1)
  url.search = query ? `${query}&${parameters}` : parameters

  if (Buffer.byteLength(url.href) > MAX_RULES_URL_BYTES) {
    reportDropped('too_many_values', URL_LIMIT)
    return
  }
  return url
}

/**
 * @param {import('node:http').IncomingHttpHeaders | undefined} headers - Headers of an applied 200 response.
 */
function reportIgnoredFlagSelection (headers) {
  const value = headers?.['dd-flag-selection-ignored']
  if (value === undefined || value === '') return

  // Anything but an exact known reason is reported as unknown, so header content never reaches logs or telemetry.
  const reason = typeof value === 'string' && IGNORED_REASONS.has(value) ? value : 'unknown'
  if (reportedIgnoredReasons.has(reason)) return
  reportedIgnoredReasons.add(reason)
  log.error(IGNORED, reason)
  tracerMetrics.count('flag_selection.ignored', { reason }).inc()
}

/**
 * @param {unknown} option - Raw `featureFlags.flagSelection` value.
 */
function warnRemoteConfigFlagSelection (option) {
  if (option === undefined || option === null) return

  const { selection, error } = canonicalize(option)
  if (selection || error) log.warn(REMOTE_CONFIG_UNSUPPORTED)
}

module.exports = {
  reportIgnoredFlagSelection,
  warnRemoteConfigFlagSelection,
  withFlagSelection,
}
