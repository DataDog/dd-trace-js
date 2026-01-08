'use strict'

const RemoteConfigCapabilities = require('../remote_config/capabilities')

/**
 * Configures remote config handlers for openfeature feature flagging
 *
 * @param {Object} rc - RemoteConfig instance
 * @param {Object} config - Tracer config
 * @param {Function} getOpenfeatureProxy - Function that returns the OpenFeature proxy from tracer
 */
function enable (rc, config, getOpenfeatureProxy) {
  // Always enable capability for feature flag configuration
  // This indicates the library supports this capability via remote config
  rc.updateCapabilities(RemoteConfigCapabilities.FFE_FLAG_CONFIGURATION_RULES, true)

  // Only register product handler if the experimental feature is enabled
  if (!config.experimental.flaggingProvider.enabled) return

  // Set product handler for FFE_FLAGS
  rc.setProductHandler('FFE_FLAGS', (action, conf) => {
    // Feed UFC config directly to OpenFeature provider
    if (action === 'apply' || action === 'modify') {
      getOpenfeatureProxy()._setConfiguration(conf)
    }
  })
}

module.exports = {
  enable
}
