'use strict'

const { registerFeature } = require('../feature-registry')

const noop = new (require('./noop'))()

/**
 * @param {import('../proxy')} proxy
 * @returns {boolean}
 */
function hasFlaggingProvider (proxy) {
  const descriptor = Reflect.getOwnPropertyDescriptor(proxy, 'openfeature')

  return descriptor?.get !== undefined || (descriptor?.value !== undefined && descriptor.value !== noop)
}

/**
 * Exposes the provider without constructing it until application code reads it.
 * The generic tracer lazy proxy is eager outside serverless environments, while
 * agentless delivery must remain silent until the application uses OpenFeature.
 *
 * @param {import('../proxy')} proxy
 * @param {import('../tracer')} tracer
 * @param {import('../config/config-base')} config
 * @param {object} configurationSource
 */
function defineFlaggingProvider (proxy, tracer, config, configurationSource) {
  Reflect.defineProperty(proxy, 'openfeature', {
    get () {
      const FlaggingProvider = require('./flagging_provider')
      const provider = new FlaggingProvider(tracer, config)

      Reflect.defineProperty(proxy, 'openfeature', {
        value: provider,
        configurable: true,
        enumerable: true,
      })
      configurationSource.enable(config, () => provider)
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
   * @param {object} rc - RemoteConfig instance
   * @param {import('../config/config-base')} config
   * @param {import('../proxy')} proxy
   */
  remoteConfig (rc, config, proxy) {
    const configurationSource = require('./configuration_source')
    const openfeatureRemoteConfig = require('./remote_config')
    const subscribe = configurationSource.isRemoteConfig(config)
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
    const configurationSource = require('./configuration_source')
    if (!configurationSource.isEnabled(config)) return

    proxy._modules.openfeature.enable(config)
    if (!hasFlaggingProvider(proxy)) {
      defineFlaggingProvider(proxy, tracer, config, configurationSource)
    }
  },
})
