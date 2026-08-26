'use strict'

const {
  EVP_EVENT_PLATFORM_SUBDOMAIN,
  EVP_PROXY_PATH_V2,
  EVP_PROXY_PATH_V4,
  EVP_SUBDOMAIN_HEADER_NAME,
} = require('../../evp_proxy/constants')
const { createDirectEVPRoute } = require('../../evp_proxy/direct')
const { discoverEVPProxy } = require('../../evp_proxy/discovery')
const logger = require('../../log')

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
 * @returns {void}
 */
function setAgentStrategy (config, setWriterEnabledValue) {
  discoverEVPProxy(config.url, {
    supportedPaths: [EVP_PROXY_PATH_V2],
  }, (error, route) => {
    if (error) {
      logger.debug('FFE Writer disabled - error getting agent info: %s', error.message)
      setWriterEnabledValue(false)
      return
    }

    if (route) {
      logger.debug('FFE Writer enabled - agent has EVP proxy support')
      setWriterEnabledValue(true, route)
    } else {
      logger.debug('FFE Writer disabled - agent does not have EVP proxy support')
      setWriterEnabledValue(false)
    }
  })
}

/**
 * Selects a local serverless receiver or authenticated direct intake.
 *
 * Local discovery is optional for delivery. A missing listener, discovery
 * error, or incompatible receiver selects direct intake when credentials exist.
 *
 * @param {import('../../config')} config - Tracer configuration object
 * @param {Function} setWriterEnabledValue - Callback to set the writer enabled state
 * @returns {void}
 */
function setAgentlessStrategy (config, setWriterEnabledValue) {
  const directRoute = createDirectEVPRoute(config, EVP_EVENT_PLATFORM_SUBDOMAIN)

  discoverEVPProxy(config.url, {
    retry: false,
    supportedPaths: [EVP_PROXY_PATH_V4, EVP_PROXY_PATH_V2],
  }, (error, localRoute) => {
    if (localRoute) {
      const route = {
        ...localRoute,
        headers: {
          [EVP_SUBDOMAIN_HEADER_NAME]: EVP_EVENT_PLATFORM_SUBDOMAIN,
        },
        ...(directRoute && { fallback: directRoute }),
      }
      logger.debug('FFE Writer enabled with local EVP route %s', route.basePath)
      setWriterEnabledValue(true, route)
      return
    }

    if (directRoute) {
      if (error) {
        logger.debug('FFE Writer using direct EVP intake after local discovery failed: %s', error.message)
      } else {
        logger.debug('FFE Writer using direct EVP intake because no compatible local route was advertised')
      }
      setWriterEnabledValue(true, directRoute)
      return
    }

    if (error) {
      logger.debug('FFE Writer disabled - error getting local receiver info: %s', error.message)
    }
    warnExposureDeliveryUnavailable()
    setWriterEnabledValue(false)
  })
}

/**
 * Applies the exposure-delivery strategy for the configured Feature Flags source.
 *
 * @param {import('../../config')} config - Tracer configuration object
 * @param {Function} setWriterEnabledValue - Callback to set the writer enabled state
 * @returns {void}
 */
function setExposureDeliveryStrategy (config, setWriterEnabledValue) {
  if (config.featureFlags?.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE === 'agentless') {
    setAgentlessStrategy(config, setWriterEnabledValue)
    return
  }

  setAgentStrategy(config, setWriterEnabledValue)
}

module.exports = { setExposureDeliveryStrategy }
