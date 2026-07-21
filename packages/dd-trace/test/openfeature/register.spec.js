'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

describe('OpenFeature register', () => {
  let config
  let configurationSource
  let feature
  let lazyProxy
  let openfeatureModule
  let openfeatureRemoteConfig
  let proxy
  let registerFeature
  let tracer

  function NoopFlaggingProvider () {}

  function FlaggingProvider (...args) {
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
    configurationSource = {
      enable: sinon.spy(),
      isEnabled: sinon.stub().returns(true),
      isRemoteConfig: sinon.stub().returns(false),
    }

    delete require.cache[require.resolve('../../src/openfeature/register')]
    proxyquire('../../src/openfeature/register', {
      '../feature-registry': { registerFeature },
      './flagging_provider': FlaggingProvider,
      './configuration_source': configurationSource,
      './remote_config': openfeatureRemoteConfig,
      './index': openfeatureModule,
      './noop': NoopFlaggingProvider,
    })

    config = {
      experimental: {
        flaggingProvider: {
          enabled: true,
        },
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

  it('does not initialize the module or construct the flagging provider until application code accesses it', () => {
    feature.enable(config, tracer, proxy, lazyProxy)

    sinon.assert.notCalled(proxy._modules.openfeature.enable)
    sinon.assert.notCalled(lazyProxy)
    sinon.assert.notCalled(configurationSource.enable)
    assert.strictEqual(typeof Reflect.getOwnPropertyDescriptor(proxy, 'openfeature').get, 'function')

    const provider = proxy.openfeature

    assert.ok(provider instanceof FlaggingProvider)
    assert.deepStrictEqual(provider.args, [tracer, config])
    sinon.assert.calledOnceWithExactly(proxy._modules.openfeature.enable, config)
    sinon.assert.calledOnceWithExactly(configurationSource.enable, config, sinon.match.func)
  })

  it('keeps an existing flagging provider on repeated enable calls', () => {
    feature.enable(config, tracer, proxy, lazyProxy)
    feature.enable(config, tracer, proxy, lazyProxy)
    sinon.assert.notCalled(proxy._modules.openfeature.enable)
    sinon.assert.notCalled(configurationSource.enable)

    const provider = proxy.openfeature
    feature.enable(config, tracer, proxy, lazyProxy)

    sinon.assert.calledTwice(proxy._modules.openfeature.enable)
    sinon.assert.notCalled(lazyProxy)
    sinon.assert.calledOnce(configurationSource.enable)
    assert.strictEqual(proxy.openfeature, provider)
  })

  it('does not define the flagging provider when disabled', () => {
    config.experimental.flaggingProvider.enabled = false
    configurationSource.isEnabled.returns(false)

    feature.enable(config, tracer, proxy, lazyProxy)

    sinon.assert.calledOnceWithExactly(configurationSource.isEnabled, config)
    sinon.assert.notCalled(proxy._modules.openfeature.enable)
    sinon.assert.notCalled(lazyProxy)
    assert.strictEqual(proxy.openfeature, feature.noop)
    sinon.assert.notCalled(configurationSource.enable)
  })

  it('installs Remote Config delivery when the provider is enabled and Remote Config is selected', () => {
    const rc = {}
    configurationSource.isRemoteConfig.returns(true)

    feature.remoteConfig(rc, config, proxy)

    sinon.assert.calledOnceWithExactly(configurationSource.isRemoteConfig, config)
    sinon.assert.calledOnceWithExactly(openfeatureRemoteConfig.enable, rc, sinon.match.func, true)
  })

  it('does not install Remote Config delivery when the provider is disabled', () => {
    const rc = {}
    config.experimental.flaggingProvider.enabled = false
    configurationSource.isRemoteConfig.returns(false)

    feature.remoteConfig(rc, config, proxy)

    sinon.assert.calledOnceWithExactly(configurationSource.isRemoteConfig, config)
    sinon.assert.calledOnceWithExactly(openfeatureRemoteConfig.enable, rc, sinon.match.func, false)
  })

  it('does not install Remote Config delivery unless explicitly selected', () => {
    const rc = {}

    feature.remoteConfig(rc, config, proxy)

    sinon.assert.calledOnceWithExactly(configurationSource.isRemoteConfig, config)
    sinon.assert.calledOnceWithExactly(openfeatureRemoteConfig.enable, rc, sinon.match.func, false)
  })
})
