'use strict'

const { registerFeature } = require('../feature-registry')

const noop = new (require('./noop'))()

/** @typedef {import('../proxy') & { openfeature: object }} OpenFeatureProxy */

/**
 * @param {import('../proxy')} proxy
 * @returns {boolean}
 */
function hasFlaggingProvider (proxy) {
  const descriptor = Reflect.getOwnPropertyDescriptor(proxy, 'openfeature')

  return descriptor?.get !== undefined || (descriptor?.value !== undefined && descriptor.value !== noop)
}

/**
 * @param {import('../proxy')} proxy
 * @returns {boolean}
 */
function hasConstructedFlaggingProvider (proxy) {
  const descriptor = Reflect.getOwnPropertyDescriptor(proxy, 'openfeature')

  return descriptor?.value !== undefined && descriptor.value !== noop
}

/**
 * @param {import('../proxy')} proxy
 * @param {import('../tracer')} tracer
 * @param {import('../config/config-base')} config
 */
function defineFlaggingProvider (proxy, tracer, config) {
  Reflect.defineProperty(proxy, 'openfeature', {
    get () {
      proxy._modules.openfeature.enable(config)

      const FlaggingProvider = require('./flagging_provider')
      const provider = new FlaggingProvider(tracer, config)

      Reflect.defineProperty(proxy, 'openfeature', {
        value: provider,
        configurable: true,
        enumerable: true,
      })
      return provider
    },
    configurable: true,
    enumerable: true,
  })
}

registerFeature({
  name: 'openfeature',
  noop,
  factory: () => require('./index'),

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

  /**
   * @param {import('../config/config-base')} config
   * @param {import('../tracer')} tracer
   * @param {import('../proxy')} proxy
   */
  enable (config, tracer, proxy) {
    if (!config.featureFlags.DD_FEATURE_FLAGS_ENABLED) return

    if (!hasFlaggingProvider(proxy)) {
      defineFlaggingProvider(proxy, tracer, config)
    } else if (hasConstructedFlaggingProvider(proxy)) {
      proxy._modules.openfeature.enable(config)
    }
  },
})
