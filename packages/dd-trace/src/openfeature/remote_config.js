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
  if (!subscribe) return

  log.debug('Feature Flags: starting remote_config configuration source (Agent Remote Configuration)')

  rc.updateCapabilities(RemoteConfigCapabilities.FFE_FLAG_CONFIGURATION_RULES, true)

  /**
   * @param {string} action
   * @param {import('@datadog/openfeature-node-server').UniversalFlagConfigurationV1} conf
   * @param {string} [id] - Remote Config configuration ID
   */
  const updateConfiguration = (action, conf, id) => {
    if (action === 'apply' || action === 'modify') {
      try {
        getOpenfeatureProxy().setConfiguration(conf)
      } catch (error) {
        // Remote Config only records the failure in its apply state, which the application cannot see.
        log.warn('Feature Flags: remote_config configuration %s could not be applied: %s', id, error?.message)
        throw error
      }
      // eslint-disable-next-line eslint-rules/eslint-log-printf-style
      log.debug(() => {
        try {
          const flagCount = Object.keys(conf?.flags ?? {}).length
          return `Feature Flags: remote_config configuration ${action} applied successfully ` +
            `(${flagCount} flag(s) received; per-flag validity is checked at evaluation, ` +
            `configuration environment=${conf?.environment?.name}, createdAt=${conf?.createdAt}, id=${id})`
        } catch {
          return 'Feature Flags: configuration applied; diagnostic details unavailable'
        }
      })
    } else if (action === 'unapply') {
      getOpenfeatureProxy().setConfiguration(undefined)
      log.debug(
        'Feature Flags: remote_config configuration %s removed; flag evaluations will return their default values',
        id
      )
    }
  }
  rc.setProductHandler('FFE_FLAGS', updateConfiguration)
}

module.exports = {
  enable,
}
