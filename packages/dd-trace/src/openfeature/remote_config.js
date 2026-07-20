'use strict'

const RemoteConfigCapabilities = require('../remote_config/capabilities')

/**
 * Configures remote config handlers for openfeature feature flagging
 *
 * @param {object} rc - RemoteConfig instance
 * @param {Function} getOpenfeatureProxy - Function that returns the OpenFeature proxy from tracer
 * @param {boolean} [subscribe] - Whether Agent Remote Config owns UFC delivery
 */
function enable (rc, getOpenfeatureProxy, subscribe = true) {
  // Capability advertisement and product subscription both opt into the billed
  // Agent Remote Config delivery path.
  if (!subscribe) return

  rc.updateCapabilities(RemoteConfigCapabilities.FFE_FLAG_CONFIGURATION_RULES, true)

  // Set product handler for FFE_FLAGS
  rc.setProductHandler('FFE_FLAGS', (action, conf) => {
    if (action === 'apply' || action === 'modify') {
      // Feed UFC config directly to OpenFeature provider
      getOpenfeatureProxy()._setConfiguration(conf)
    } else if (action === 'unapply') {
      // Clear the configuration so evaluations return PROVIDER_NOT_READY,
      // consistent with Go and Python which also set config to null on RC deletion.
      // The evaluator returns PROVIDER_NOT_READY when config is null/undefined.
      getOpenfeatureProxy()._setConfiguration(null)
    }
  })
}

module.exports = {
  enable,
}
