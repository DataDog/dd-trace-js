'use strict'

const { registerFeature } = require('../feature-registry')

const noop = new (require('./noop'))()

/**
 * @param {import('../proxy')} proxy
 * @returns {boolean}
 */
function hasFlaggingProvider (proxy) {
  const descriptor = Reflect.getOwnPropertyDescriptor(proxy, 'openfeature')

  return descriptor?.value !== undefined && descriptor.value !== noop
}

registerFeature({
  name: 'openfeature',
  noop,
  factory: () => require('./index'),

  /**
   * @param {object} rc - RemoteConfig instance
   * @param {import('../config/config-base')} config
   * @param {import('../proxy')} proxy
   */
  remoteConfig (rc, config, proxy) {
    const configurationSource = require('./configuration_source')
    const openfeatureRemoteConfig = require('./remote_config')
    openfeatureRemoteConfig.enable(
      rc,
      config,
      () => proxy.openfeature,
      configurationSource.isRemoteConfig(config)
    )
  },

  /**
   * @param {import('../config/config-base')} config
   * @param {import('../tracer')} tracer
   * @param {import('../proxy')} proxy
   * @param {Function} lazyProxy
   */
  enable (config, tracer, proxy, lazyProxy) {
    if (config.experimental.flaggingProvider.enabled) {
      proxy._modules.openfeature.enable(config)
      if (!hasFlaggingProvider(proxy)) {
        lazyProxy(proxy, 'openfeature', () => require('./flagging_provider'), tracer, config)
      }
      const configurationSource = require('./configuration_source')
      configurationSource.enable(config, () => proxy.openfeature)
    }
  },
})
