'use strict'

const { isLoopbackHost } = require('../exporters/common/url')
const log = require('../log')

const DEFAULT_AGENTLESS_PATH = '/api/v2/feature-flagging/config/rules-based/server'
const MAX_POLL_INTERVAL_SECONDS = 60 * 60

/**
 * @typedef {import('@datadog/openfeature-node-server').UniversalFlagConfigurationV1} UniversalFlagConfiguration
 */

/**
 * @param {import('../config/config-base')} config
 * @param {(configuration: UniversalFlagConfiguration) => void} applyConfiguration
 */
function create (config, applyConfiguration) {
  const {
    DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: source,
    DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL: baseUrl,
    DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_POLL_INTERVAL_SECONDS: pollIntervalSeconds,
    DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_REQUEST_TIMEOUT_SECONDS: requestTimeoutSeconds,
    DD_FEATURE_FLAGS_ENABLED: enabled,
  } = config.featureFlags

  if (!enabled || source !== 'agentless') {
    return
  }

  try {
    if (!config.DD_API_KEY) {
      throw new Error('DD_API_KEY is required for Feature Flagging agentless delivery')
    }

    const AgentlessConfigurationSource = require('./agentless_configuration_source')
    return new AgentlessConfigurationSource({
      endpoint: endpoint(config, baseUrl),
      pollIntervalMs: Math.min(pollIntervalSeconds, MAX_POLL_INTERVAL_SECONDS) * 1000,
      requestTimeoutMs: requestTimeoutSeconds * 1000,
      apiKey: config.DD_API_KEY,
    }, applyConfiguration)
  } catch (error) {
    log.error('Unable to configure Feature Flagging configuration source', error)
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
    const url = new URL(`https://ufc-server.ff-cdn.${config.site.toLowerCase()}${DEFAULT_AGENTLESS_PATH}`)
    if (config.env) url.searchParams.set('dd_env', config.env)
    return url
  }

  let url
  try {
    url = new URL(configured)
  } catch {
    throw new Error('Invalid Feature Flagging agentless URL')
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Feature Flagging agentless URL must use HTTP or HTTPS')
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new Error('Feature Flagging agentless URL must use HTTPS unless it targets loopback')
  }

  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = DEFAULT_AGENTLESS_PATH
  }

  return url
}

module.exports = {
  create,
}
