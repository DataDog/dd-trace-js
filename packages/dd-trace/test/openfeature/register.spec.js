'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

describe('OpenFeature register', () => {
  let config
  let feature
  let flaggingProviderConstructions
  let lazyProxy
  let openfeatureModule
  let openfeatureRemoteConfig
  let proxy
  let registerFeature
  let tracer

  function NoopFlaggingProvider () {}

  function FlaggingProvider (...args) {
    flaggingProviderConstructions++
    this.args = args
  }

  beforeEach(() => {
    registerFeature = sinon.spy(registeredFeature => {
      feature = registeredFeature
    })
    openfeatureModule = {
      enable: sinon.spy(),
      disable: sinon.spy(),
    }
    openfeatureRemoteConfig = {
      enable: sinon.spy(),
    }
    flaggingProviderConstructions = 0

    delete require.cache[require.resolve('../../src/openfeature/register')]
    proxyquire('../../src/openfeature/register', {
      '../feature-registry': { registerFeature },
      './flagging_provider': FlaggingProvider,
      './remote_config': openfeatureRemoteConfig,
      './index': openfeatureModule,
      './noop': NoopFlaggingProvider,
    })

    config = {
      featureFlags: {
        DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless',
        DD_FEATURE_FLAGS_ENABLED: true,
      },
    }
    tracer = {}
    proxy = {
      openfeature: feature.noop,
      _modules: {
        openfeature: {
          enable: sinon.spy(),
        },
      },
    }
    lazyProxy = sinon.spy((target, property, getClass, ...args) => {
      const RealClass = getClass()
      target[property] = new RealClass(...args)
    })
  })

  it('registers the OpenFeature feature', () => {
    sinon.assert.calledOnce(registerFeature)

    assert.strictEqual(feature.name, 'openfeature')
    assert.ok(feature.noop instanceof NoopFlaggingProvider)
    assert.strictEqual(feature.factory(), openfeatureModule)
  })

  it('does not initialize Feature Flags until application code accesses the provider', () => {
    feature.enable(config, tracer, proxy, lazyProxy)

    assert.strictEqual(flaggingProviderConstructions, 0)
    sinon.assert.notCalled(proxy._modules.openfeature.enable)
    sinon.assert.notCalled(lazyProxy)

    const provider = proxy.openfeature

    assert.strictEqual(flaggingProviderConstructions, 1)
    assert.ok(provider instanceof FlaggingProvider)
    assert.deepStrictEqual(provider.args, [tracer, config])
    sinon.assert.calledOnceWithExactly(proxy._modules.openfeature.enable, config)
  })

  it('keeps an existing flagging provider on repeated enable calls', () => {
    feature.enable(config, tracer, proxy, lazyProxy)
    feature.enable(config, tracer, proxy, lazyProxy)
    assert.strictEqual(flaggingProviderConstructions, 0)
    sinon.assert.notCalled(proxy._modules.openfeature.enable)

    const provider = proxy.openfeature
    feature.enable(config, tracer, proxy, lazyProxy)

    assert.strictEqual(flaggingProviderConstructions, 1)
    sinon.assert.calledTwice(proxy._modules.openfeature.enable)
    sinon.assert.notCalled(lazyProxy)
    assert.strictEqual(proxy.openfeature, provider)
  })

  it('does not define the flagging provider when disabled', () => {
    config.featureFlags.DD_FEATURE_FLAGS_ENABLED = false

    feature.enable(config, tracer, proxy, lazyProxy)

    assert.strictEqual(flaggingProviderConstructions, 0)
    sinon.assert.notCalled(proxy._modules.openfeature.enable)
    sinon.assert.notCalled(lazyProxy)
    assert.strictEqual(proxy.openfeature, feature.noop)
  })

  it('installs Remote Config delivery when selected', () => {
    const rc = {}
    config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE = 'remote_config'

    feature.remoteConfig(rc, config, proxy)

    sinon.assert.calledOnceWithExactly(openfeatureRemoteConfig.enable, rc, sinon.match.func, true)
  })

  it('does not install Remote Config delivery when disabled', () => {
    const rc = {}
    config.featureFlags.DD_FEATURE_FLAGS_ENABLED = false

    feature.remoteConfig(rc, config, proxy)

    sinon.assert.calledOnceWithExactly(openfeatureRemoteConfig.enable, rc, sinon.match.func, false)
  })

  it('does not install Remote Config delivery for the default agentless source', () => {
    const rc = {}

    feature.remoteConfig(rc, config, proxy)

    sinon.assert.calledOnceWithExactly(openfeatureRemoteConfig.enable, rc, sinon.match.func, false)
  })
})
