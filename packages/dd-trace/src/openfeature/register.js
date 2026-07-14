'use strict'

const { registerFeature } = require('../feature-registry')

registerFeature({
  name: 'openfeature',
  noop: new (require('./noop'))(),
  factory: () => require('./index'),

  /**
   * @param {object} rc - RemoteConfig instance
   * @param {import('../config/config-base')} config
   * @param {import('../proxy')} proxy
   */
  remoteConfig (rc, config, proxy) {
    const openfeatureRemoteConfig = require('./remote_config')
    openfeatureRemoteConfig.enable(rc, config, () => proxy.openfeature)
  },

  /**
   * @param {import('../config/config-base')} config
   * @param {import('../tracer')} tracer
   * @param {import('../proxy')} proxy
   * @param {Function} lazyProxy
   */
  enable (config, tracer, proxy, lazyProxy) {
    if (config.experimental.flaggingProvider.enabled) {
      const openfeature = proxy._modules.openfeature
      const shouldCreateProvider = openfeature.module === undefined

      openfeature.enable(config)

      if (shouldCreateProvider) {
        lazyProxy(proxy, 'openfeature', () => require('./flagging_provider'), tracer, config)
      }
    }
  },
})
