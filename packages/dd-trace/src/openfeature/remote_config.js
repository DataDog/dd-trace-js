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
      getOpenfeatureProxy().setConfiguration(conf)
      // Counting flags allocates a key array, so it stays behind the debug callback.
      // eslint-disable-next-line eslint-rules/eslint-log-printf-style
      log.debug(() => {
        // The payload is not schema-validated and this runs after setConfiguration, so a throw here would
        // report an already applied configuration as failed only when debug logging is on. Template literals
        // throw on values such as `{ toString: null }`, so the callback returns printf arguments instead.
        const flagCount = Object.keys(conf?.flags ?? {}).length
        return [
          'Feature Flags: remote_config configuration %s applied successfully ' +
          '(%d flag(s) received; per-flag validity is checked at evaluation, ' +
          'configuration environment=%s, createdAt=%s, id=%s)',
          action, flagCount, conf?.environment?.name, conf?.createdAt, id,
        ]
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
