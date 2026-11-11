'use strict'

const { createSiteUrl } = require('../exporters/common/url')
const log = require('../log')

const DEFAULT_AGENTLESS_PATH = '/api/v2/feature-flagging/config/rules-based/server'
const MAX_POLL_INTERVAL_SECONDS = 60 * 60
const AGENTLESS_START_MESSAGE = 'Feature Flags: starting agentless configuration source at %s ' +
  '(%s endpoint, poll interval %ds, request timeout %ds, DD-API-KEY header %s)'
const REMOTE_CONFIG_DISABLED_WARNING = 'Feature Flags: configuration source is remote_config but Remote ' +
  'Configuration is disabled; flag evaluations will return their default values. Set ' +
  'DD_REMOTE_CONFIGURATION_ENABLED=true or DD_FEATURE_FLAGS_CONFIGURATION_SOURCE=agentless'
// The CDN uses DD-Service for usage attribution only when the value matches this pattern. It ignores other values.
const USAGE_SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,99}$/
const USAGE_SERVICE_REJECTED_MESSAGE = 'Feature Flags: service %s has no APM name the CDN can attribute usage to; ' +
  'DD-Service header not sent'
// The Agent cuts span service names to this many UTF-8 bytes before it normalizes them.
const MAX_APM_SERVICE_BYTES = 100
const APM_SERVICE_ASCII_CHAR = /^[a-z0-9:./-]$/
const APM_SERVICE_NON_ASCII_CHAR = /^[\p{L}\p{Nd}]$/u

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
 * Selects the DD-Service value: the name that APM shows for the tracer service. Thus the usage goes to the same
 * service as the traces. For example, `My Service` becomes `my_service`.
 *
 * If the CDN does not accept the APM name (for example `_svc` or `café-api`), no value is sent. A different name
 * would attribute the usage to the wrong service. The tracer service itself does not change. A value that is sent is
 * always plain ASCII, so Node.js cannot throw on the header.
 *
 * @param {string | undefined} service - Tracer service name.
 */
function usageService (service) {
  const name = service ? apmServiceName(service) : ''
  const accepted = USAGE_SERVICE_PATTERN.test(name)
  if (service && !accepted) log.debug(USAGE_SERVICE_REJECTED_MESSAGE, service)
  return accepted ? name : undefined
}

/**
 * Normalizes a service name with the same rules as the Agent `NormalizeService` for spans. Returns an empty string if
 * nothing is left. The rules:
 * - Cut the name to 100 UTF-8 bytes. Do not split a character.
 * - Change ASCII capital letters to lowercase.
 * - Keep letters, digits, and `:./-`.
 * - Replace each run of other characters (`_` included) with one `_`. Remove a run at the end.
 *
 * Non-ASCII letters stay. The CDN pattern then rejects the name.
 *
 * @param {string} service - Tracer service name.
 */
function apmServiceName (service) {
  let name = ''
  let bytes = 0
  let pendingUnderscore = false
  for (const character of service) {
    bytes += Buffer.byteLength(character)
    if (bytes > MAX_APM_SERVICE_BYTES) break
    const char = character >= 'A' && character <= 'Z' ? character.toLowerCase() : character
    if (APM_SERVICE_ASCII_CHAR.test(char) || (char > '\u007F' && APM_SERVICE_NON_ASCII_CHAR.test(char))) {
      if (pendingUnderscore) name += '_'
      pendingUnderscore = false
      name += char
    } else {
      pendingUnderscore = true
    }
  }
  return name
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
