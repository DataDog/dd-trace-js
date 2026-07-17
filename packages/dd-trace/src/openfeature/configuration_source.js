'use strict'

const log = require('../log')

const CONFIGURATION_SOURCE_AGENTLESS = 'agentless'
const CONFIGURATION_SOURCE_REMOTE_CONFIG = 'remote_config'

const DEFAULT_AGENTLESS_PATH = '/api/v2/feature-flagging/config/rules-based/server'
const DEFAULT_POLL_INTERVAL_SECONDS = 30
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 2
const MAX_POLL_INTERVAL_SECONDS = 60 * 60

/**
 * Resolves Feature Flagging configuration-source settings.
 *
 * @param {import('../config/config-base')} config - Tracer configuration.
 * @returns {object} Resolved source settings.
 */
function resolve (config) {
  const mode = resolveMode(config)

  if (mode === CONFIGURATION_SOURCE_REMOTE_CONFIG) {
    return { mode }
  }

  return {
    mode,
    endpoint: endpoint(config, config.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL),
    pollIntervalMs: positiveMilliseconds(
      config.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_POLL_INTERVAL_SECONDS,
      DEFAULT_POLL_INTERVAL_SECONDS,
      'poll interval',
      MAX_POLL_INTERVAL_SECONDS
    ),
    requestTimeoutMs: positiveMilliseconds(
      config.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_REQUEST_TIMEOUT_SECONDS,
      DEFAULT_REQUEST_TIMEOUT_SECONDS,
      'request timeout'
    ),
    apiKey: config.DD_API_KEY,
  }
}

/**
 * Reports whether the explicit Remote Config source is selected.
 *
 * Invalid source values fail closed and do not enable Remote Config delivery.
 *
 * @param {import('../config/config-base')} config - Tracer configuration.
 * @returns {boolean} Whether Remote Config should own UFC delivery.
 */
function isRemoteConfig (config) {
  try {
    return resolveMode(config) === CONFIGURATION_SOURCE_REMOTE_CONFIG
  } catch (error) {
    log.error('Unable to configure Feature Flagging configuration source', error)
    return false
  }
}

/**
 * Normalizes and validates source selection without resolving agentless
 * endpoint or timing configuration.
 *
 * @param {import('../config/config-base')} config - Tracer configuration.
 * @returns {string} Selected configuration-source mode.
 */
function resolveMode (config) {
  const value = config.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE
  const mode = String(value ?? '').trim().toLowerCase() || CONFIGURATION_SOURCE_AGENTLESS
  if (mode !== CONFIGURATION_SOURCE_AGENTLESS && mode !== CONFIGURATION_SOURCE_REMOTE_CONFIG) {
    throw new Error(`Unsupported Feature Flagging configuration source: ${mode}`)
  }
  return mode
}

/**
 * Builds the agentless rules-based server endpoint.
 *
 * A configured URL with a non-root path is treated as the exact endpoint. A
 * configured origin (or root URL) receives the standard rules-based server
 * path.
 *
 * @param {import('../config/config-base')} config - Tracer configuration.
 * @param {string | undefined} configuredBaseUrl - Optional endpoint or origin override.
 * @returns {URL} Agentless endpoint.
 */
function endpoint (config, configuredBaseUrl) {
  const configured = configuredBaseUrl?.trim()

  if (!configured) {
    const url = new URL(`https://ufc-server.ff-cdn.${String(config.site).toLowerCase()}${DEFAULT_AGENTLESS_PATH}`)
    if (config.env) url.searchParams.set('dd_env', config.env)
    return url
  }

  let url
  try {
    url = new URL(configured)
  } catch (error) {
    throw new Error(`Invalid Feature Flagging agentless URL: ${configured}`, { cause: error })
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Feature Flagging agentless URL must use HTTP or HTTPS')
  }

  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = DEFAULT_AGENTLESS_PATH
  }

  return url
}

/**
 * Converts a positive number of seconds to milliseconds, falling back for
 * invalid or non-positive values.
 *
 * @param {unknown} value - Configured seconds.
 * @param {number} fallbackSeconds - Default seconds.
 * @param {string} setting - Human-readable setting name.
 * @param {number} [maximumSeconds] - Optional inclusive maximum.
 * @returns {number} Positive milliseconds.
 */
function positiveMilliseconds (value, fallbackSeconds, setting, maximumSeconds) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    log.warn(
      'Invalid Feature Flagging agentless %s: %s. The value must be positive; using %ss',
      setting,
      value,
      fallbackSeconds
    )
    return fallbackSeconds * 1000
  }
  if (maximumSeconds !== undefined && seconds > maximumSeconds) {
    log.warn(
      'Feature Flagging agentless %s %s exceeds the maximum of %ss; using %ss',
      setting,
      value,
      maximumSeconds,
      maximumSeconds
    )
    return maximumSeconds * 1000
  }
  return Math.max(1, Math.round(seconds * 1000))
}

module.exports = {
  isRemoteConfig,
  resolve,
}
