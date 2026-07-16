'use strict'

const log = require('../log')

const CONFIGURATION_SOURCE_AGENTLESS = 'agentless'
const CONFIGURATION_SOURCE_REMOTE_CONFIG = 'remote_config'

const DEFAULT_AGENTLESS_PATH = '/api/v2/feature-flagging/config/rules-based/server'
const DEFAULT_POLL_INTERVAL_SECONDS = 30
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 2
const GOV_CLOUD_SITE = 'ddog-gov.com'

/**
 * Resolves Feature Flagging configuration-source settings.
 *
 * @param {import('../config/config-base')} config - Tracer configuration.
 * @returns {object} Resolved source settings.
 */
function resolve (config) {
  const flaggingProvider = config.experimental.flaggingProvider
  const mode = String(flaggingProvider.configurationSource ?? '').trim().toLowerCase() || CONFIGURATION_SOURCE_AGENTLESS

  if (mode === CONFIGURATION_SOURCE_REMOTE_CONFIG) {
    return { mode }
  }

  if (mode !== CONFIGURATION_SOURCE_AGENTLESS) {
    throw new Error(`Unsupported Feature Flagging configuration source: ${mode}`)
  }

  const configuredBaseUrl = flaggingProvider.agentlessBaseUrl?.trim()
  if (!configuredBaseUrl && String(config.DD_SITE).trim().toLowerCase() === GOV_CLOUD_SITE) {
    log.warn(
      'Datadog-managed Feature Flagging agentless delivery is not supported on GovCloud; evaluations will use defaults'
    )
    return { mode }
  }

  return {
    mode,
    endpoint: endpoint(config, configuredBaseUrl),
    pollIntervalMs: positiveMilliseconds(
      flaggingProvider.agentlessPollIntervalSeconds,
      DEFAULT_POLL_INTERVAL_SECONDS,
      'poll interval'
    ),
    requestTimeoutMs: positiveMilliseconds(
      flaggingProvider.agentlessRequestTimeoutSeconds,
      DEFAULT_REQUEST_TIMEOUT_SECONDS,
      'request timeout'
    ),
    apiKey: config.DD_API_KEY,
  }
}

/**
 * Starts the selected first-party configuration source.
 *
 * Remote Config is installed separately because its lifecycle is owned by the
 * tracer Remote Config client.
 *
 * @param {import('../config/config-base')} config - Tracer configuration.
 * @param {Function} getOpenfeatureProxy - Returns the active provider.
 * @returns {void}
 */
function enable (config, getOpenfeatureProxy) {
  let sourceConfig
  try {
    sourceConfig = resolve(config)
  } catch (error) {
    log.error('Unable to configure Feature Flagging configuration source', error)
    return
  }

  if (sourceConfig.mode === CONFIGURATION_SOURCE_AGENTLESS && sourceConfig.endpoint) {
    const AgentlessConfigurationSource = require('./agentless_configuration_source')
    const source = new AgentlessConfigurationSource(sourceConfig, ufc => {
      getOpenfeatureProxy()._setConfiguration(ufc)
    })
    getOpenfeatureProxy()._setConfigurationSource(source)
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
    return resolve(config).mode === CONFIGURATION_SOURCE_REMOTE_CONFIG
  } catch (error) {
    log.error('Unable to configure Feature Flagging configuration source', error)
    return false
  }
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
    const url = new URL(`https://ufc-server.ff-cdn.${String(config.DD_SITE).toLowerCase()}${DEFAULT_AGENTLESS_PATH}`)
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
 * @returns {number} Positive milliseconds.
 */
function positiveMilliseconds (value, fallbackSeconds, setting) {
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
  return Math.max(1, Math.round(seconds * 1000))
}

module.exports = {
  CONFIGURATION_SOURCE_AGENTLESS,
  CONFIGURATION_SOURCE_REMOTE_CONFIG,
  DEFAULT_AGENTLESS_PATH,
  enable,
  endpoint,
  isRemoteConfig,
  resolve,
}
