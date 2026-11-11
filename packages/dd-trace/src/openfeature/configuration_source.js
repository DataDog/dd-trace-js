'use strict'

const { normalizeService } = require('../config/normalize-service')
const { createSiteUrl } = require('../exporters/common/url')
const log = require('../log')

const DEFAULT_AGENTLESS_PATH = '/api/v2/feature-flagging/config/rules-based/server'
const MAX_POLL_INTERVAL_SECONDS = 60 * 60
const AGENTLESS_START_MESSAGE = 'Feature Flags: starting agentless configuration source at %s ' +
  '(%s endpoint, poll interval %ds, request timeout %ds, DD-API-KEY header %s)'
const REMOTE_CONFIG_DISABLED_WARNING = 'Feature Flags: configuration source is remote_config but Remote ' +
  'Configuration is disabled; flag evaluations will return their default values. Set ' +
  'DD_REMOTE_CONFIGURATION_ENABLED=true or DD_FEATURE_FLAGS_CONFIGURATION_SOURCE=agentless'
// The CDN attributes configuration requests to the DD-Service header only when it matches this, and drops any other
// value.
const USAGE_SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,99}$/
const USAGE_SERVICE_REJECTED_MESSAGE = 'Feature Flags: service %s has nothing left the CDN can attribute usage to ' +
  'once cleaned up; DD-Service header not sent'

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

  if (!enabled) return

  if (source !== 'agentless') {
    log.debug('Feature Flags: configuration source is %s, not agentless; skipping agentless setup', source)
    if (source === 'remote_config' && !config.remoteConfig?.DD_REMOTE_CONFIGURATION_ENABLED) {
      log.warn(REMOTE_CONFIG_DISABLED_WARNING)
    }
    return
  }

  const hasCustomEndpoint = Boolean(baseUrl?.trim())

  try {
    if (!hasCustomEndpoint && !config.DD_API_KEY) {
      throw new Error('DD_API_KEY is required for the default Datadog Feature Flagging endpoint')
    }

    const AgentlessConfigurationSource = require('./agentless_configuration_source')
    const resolvedEndpoint = endpoint(config, baseUrl)
    const effectivePollIntervalSeconds = Math.min(pollIntervalSeconds, MAX_POLL_INTERVAL_SECONDS)
    log.debug(
      AGENTLESS_START_MESSAGE,
      redactedUrl(resolvedEndpoint),
      hasCustomEndpoint ? 'custom' : 'default',
      effectivePollIntervalSeconds,
      requestTimeoutSeconds,
      hasCustomEndpoint ? 'not sent' : 'sent'
    )
    return new AgentlessConfigurationSource({
      endpoint: resolvedEndpoint,
      pollIntervalMs: effectivePollIntervalSeconds * 1000,
      requestTimeoutMs: requestTimeoutSeconds * 1000,
      apiKey: hasCustomEndpoint ? undefined : config.DD_API_KEY,
      env: config.env,
      service: usageService(config.service),
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
    const url = createSiteUrl(config.site, 'ufc-server.ff-cdn')
    if (url === undefined) throw new Error('Invalid DD_SITE for Feature Flagging agentless configuration')
    url.pathname = DEFAULT_AGENTLESS_PATH
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
  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = DEFAULT_AGENTLESS_PATH
  }

  return url
}

/**
 * Selects the service sent as DD-Service. The name is cleaned up the way the Agent cleans up span service names, so
 * `My Service` is attributed as `my_service`, as in APM, instead of being dropped by the CDN. Only this header value is
 * cleaned up; the tracer's service stays as configured. A name with nothing left once cleaned up is not sent. Cleaning
 * up also removes characters outside Latin-1, which make Node.js throw and would end the polling loop.
 *
 * @param {string | undefined} service - Tracer service name.
 */
function usageService (service) {
  const cleaned = normalizeService(service)
  const accepted = cleaned !== undefined && USAGE_SERVICE_PATTERN.test(cleaned)
  if (service && !accepted) log.debug(USAGE_SERVICE_REJECTED_MESSAGE, service)
  return accepted ? cleaned : undefined
}

/**
 * Drops everything but the origin; a custom base URL may embed a signed token in its path.
 *
 * @param {URL} url
 */
function redactedUrl (url) {
  return `${url.protocol}//${url.host}`
}

module.exports = {
  create,
}
