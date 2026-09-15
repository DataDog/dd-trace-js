'use strict'

const {
  EVP_EVENT_PLATFORM_SUBDOMAIN,
  EVP_ORIGIN_HEADER_NAME,
  EVP_ORIGIN_VERSION_HEADER_NAME,
  EVP_PROXY_PATH_V2,
  EVP_PROXY_PATH_V4,
  EVP_SUBDOMAIN_HEADER_NAME,
} = require('../../evp_proxy/constants')
const { createDirectEVPRoute } = require('../../evp_proxy/direct')
const { discoverEVPProxy } = require('../../evp_proxy/discovery')
const { joinAgentURLPath } = require('../../evp_proxy/path')
const logger = require('../../log')

const ROUTE_DISCOVERY_COOLDOWN_MS = 60_000
const REQUIRED_LOCAL_HEADERS = [EVP_ORIGIN_HEADER_NAME, EVP_ORIGIN_VERSION_HEADER_NAME]
const STOP_NOOP = () => {}

let missingRouteWarningLogged = false

/**
 * Logs the unavailable exposure-delivery warning once.
 *
 * @returns {void}
 */
function warnExposureDeliveryUnavailable () {
  if (missingRouteWarningLogged) return
  missingRouteWarningLogged = true
  logger.warn(
    'Feature Flags exposure delivery is disabled because no compatible local EVP route or direct intake ' +
    'credentials are available.'
  )
}

/**
 * Preserves Agent exposure delivery for the Remote Configuration source.
 *
 * @param {import('../../config')} config - Tracer configuration object
 * @param {Function} setWriterEnabledValue - Callback to set the writer enabled state
 * @returns {Function} Stop callback
 */
function setAgentStrategy (config, setWriterEnabledValue) {
  setWriterEnabledValue(true, {
    url: config.url,
    basePath: joinAgentURLPath(config.url, EVP_PROXY_PATH_V2),
    headers: {
      [EVP_SUBDOMAIN_HEADER_NAME]: EVP_EVENT_PLATFORM_SUBDOMAIN,
    },
  })
  return STOP_NOOP
}

/**
 * Selects a local serverless receiver or authenticated direct intake.
 *
 * Local discovery is optional for delivery. A missing listener, discovery
 * error, or incompatible receiver selects direct intake when credentials exist.
 *
 * @param {import('../../config')} config - Tracer configuration object
 * @param {Function} setWriterEnabledValue - Callback to set the writer enabled state
 * @returns {Function} Stop callback
 */
function setAgentlessStrategy (config, setWriterEnabledValue) {
  const directRoute = createDirectEVPRoute(config, EVP_EVENT_PLATFORM_SUBDOMAIN)
  let discovering = false
  let recoveryTimer
  let state = 'unknown'
  let stopped = false

  /** @returns {void} */
  const stop = () => {
    stopped = true
    clearTimeout(recoveryTimer)
    recoveryTimer = undefined
  }

  /** @returns {void} */
  const scheduleRecovery = () => {
    if (stopped || state !== 'unavailable' || recoveryTimer !== undefined) return

    recoveryTimer = setTimeout(discover, ROUTE_DISCOVERY_COOLDOWN_MS)
    recoveryTimer.unref?.()
  }

  /** @returns {void} */
  const markUnavailable = () => {
    if (stopped || state === 'direct') return
    if (state !== 'unavailable') {
      state = 'unavailable'
      setWriterEnabledValue(false)
    }
    scheduleRecovery()
  }

  /** @returns {void} */
  const activateDirect = () => {
    if (stopped || state === 'direct' || directRoute === undefined) return
    state = 'direct'
    clearTimeout(recoveryTimer)
    recoveryTimer = undefined
    setWriterEnabledValue(true, directRoute)
  }

  /**
   * @param {{url: URL, basePath: string}} localRoute - Discovered local route
   * @returns {void}
   */
  const activateLocal = localRoute => {
    state = 'local'
    const route = {
      ...localRoute,
      headers: {
        [EVP_SUBDOMAIN_HEADER_NAME]: EVP_EVENT_PLATFORM_SUBDOMAIN,
      },
    }
    if (directRoute) {
      route.fallback = directRoute
      route.onFallback = activateDirect
    } else {
      route.onUnavailable = markUnavailable
    }
    logger.debug('FFE Writer enabled with local EVP route %s', route.basePath)
    setWriterEnabledValue(true, route)
  }

  /** @returns {void} */
  function discover () {
    recoveryTimer = undefined
    if (stopped || state === 'direct' || discovering) return
    discovering = true

    discoverEVPProxy(config.url, {
      requiredHeaders: REQUIRED_LOCAL_HEADERS,
      supportedPaths: [EVP_PROXY_PATH_V4, EVP_PROXY_PATH_V2],
    }, (error, localRoute) => {
      discovering = false
      if (stopped || state === 'direct') return

      if (localRoute) {
        activateLocal(localRoute)
        return
      }

      if (directRoute) {
        if (error) {
          logger.debug('FFE Writer using direct EVP intake after local discovery failed: %s', error.message)
        } else {
          logger.debug('FFE Writer using direct EVP intake because no compatible local route was advertised')
        }
        activateDirect()
        return
      }

      if (error) {
        logger.debug('FFE Writer disabled - error getting local receiver info: %s', error.message)
      }
      warnExposureDeliveryUnavailable()
      markUnavailable()
    })
  }

  discover()
  return stop
}

/**
 * Applies one event-delivery strategy that can be shared by all Feature Flags writers.
 *
 * @param {import('../../config')} config - Tracer configuration object
 * @param {Function} setWriterEnabledValue - Callback to set the writer enabled state
 * @returns {Function} Stop callback
 */
function setEventDeliveryStrategy (config, setWriterEnabledValue) {
  if (config.featureFlags?.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE === 'agentless') {
    return setAgentlessStrategy(config, setWriterEnabledValue)
  }

  return setAgentStrategy(config, setWriterEnabledValue)
}

module.exports = {
  setEventDeliveryStrategy,
  setExposureDeliveryStrategy: setEventDeliveryStrategy,
}
