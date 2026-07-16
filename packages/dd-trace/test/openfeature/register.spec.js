'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

describe('OpenFeature register', () => {
  let config
  let feature
  let lazyProxy
  let openfeatureModule
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

    delete require.cache[require.resolve('../../src/openfeature/register')]
    proxyquire('../../src/openfeature/register', {
      '../feature-registry': { registerFeature },
      './flagging_provider': FlaggingProvider,
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

  it('defines the flagging provider when enabled', () => {
    feature.enable(config, tracer, proxy, lazyProxy)

    sinon.assert.calledOnceWithExactly(proxy._modules.openfeature.enable, config)
    sinon.assert.calledOnce(lazyProxy)
    assert.ok(proxy.openfeature instanceof FlaggingProvider)
    assert.deepStrictEqual(proxy.openfeature.args, [tracer, config])
  })

  it('keeps an existing flagging provider on repeated enable calls', () => {
    feature.enable(config, tracer, proxy, lazyProxy)
    const provider = proxy.openfeature

    feature.enable(config, tracer, proxy, lazyProxy)

    sinon.assert.calledTwice(proxy._modules.openfeature.enable)
    sinon.assert.calledOnce(lazyProxy)
    assert.strictEqual(proxy.openfeature, provider)
  })

  it('does not define the flagging provider when disabled', () => {
    config.experimental.flaggingProvider.enabled = false

    feature.enable(config, tracer, proxy, lazyProxy)

    sinon.assert.notCalled(proxy._modules.openfeature.enable)
    sinon.assert.notCalled(lazyProxy)
    assert.strictEqual(proxy.openfeature, feature.noop)
  })
})
