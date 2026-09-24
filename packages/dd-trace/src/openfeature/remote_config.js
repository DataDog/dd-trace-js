'use strict'

const log = require('../log')
const RemoteConfigCapabilities = require('../remote_config/capabilities')

/**
 * Configures remote config handlers for openfeature feature flagging
 *
 * @param {import('../remote_config')} rc - RemoteConfig instance
 * @param {() => InstanceType<ReturnType<typeof import('./flagging_provider')>>} getOpenfeatureProxy
 * @param {boolean} subscribe - Whether Agent Remote Config owns UFC delivery
 */
function enable (rc, getOpenfeatureProxy, subscribe) {
  if (!subscribe) {
    log.debug('Feature Flags: configuration source is not remote_config; skipping Remote Config setup')
    return
  }

  log.debug('Feature Flags: starting remote_config configuration source (Agent Remote Configuration)')

  rc.updateCapabilities(RemoteConfigCapabilities.FFE_FLAG_CONFIGURATION_RULES, true)

  /**
   * @param {string} action
   * @param {import('@datadog/openfeature-node-server').UniversalFlagConfigurationV1} conf
   */
  const updateConfiguration = (action, conf) => {
    if (action === 'apply' || action === 'modify') {
      log.debug('Feature Flags: remote_config configuration %s applied successfully (%d flag(s))',
        action, Object.keys(conf?.flags ?? {}).length)
      getOpenfeatureProxy().setConfiguration(conf)
    } else if (action === 'unapply') {
      log.debug('Feature Flags: remote_config configuration removed')
      getOpenfeatureProxy().setConfiguration(undefined)
    }
  }
  rc.setProductHandler('FFE_FLAGS', updateConfiguration)
}

module.exports = {
  enable,
}
