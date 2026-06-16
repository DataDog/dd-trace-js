'use strict'

const Tracer = require('../proxy')
const NoopProxy = require('../noop/proxy')

Tracer.registerFeature({
  name: 'openfeature',
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
      proxy._modules.openfeature.enable(config)
      lazyProxy(proxy, 'openfeature', () => require('./flagging_provider'), tracer, config)
    }
  },
})

NoopProxy.registerNoop('openfeature', new (require('./noop'))())
