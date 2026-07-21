'use strict'

const { registerFeature } = require('../feature-registry')

const noop = new (require('./noop'))()

/** @typedef {import('../proxy') & { openfeature: object }} OpenFeatureProxy */

registerFeature({
  name: 'openfeature',
  noop,
  factory: () => require('./index'),
  provider: () => require('./flagging_provider'),

  /** @param {import('../config/config-base')} config */
  isEnabled (config) {
    return config.featureFlags.DD_FEATURE_FLAGS_ENABLED
  },

  /**
   * @param {import('../remote_config')} rc - RemoteConfig instance
   * @param {import('../config/config-base')} config
   * @param {OpenFeatureProxy} proxy
   */
  remoteConfig (rc, config, proxy) {
    const openfeatureRemoteConfig = require('./remote_config')
    const subscribe = config.featureFlags.DD_FEATURE_FLAGS_ENABLED &&
      config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE === 'remote_config'
    openfeatureRemoteConfig.enable(
      rc,
      () => proxy.openfeature,
      subscribe
    )
  },
})
