'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

require('../../setup/core')

describe('OpenFeature event delivery strategy', () => {
  let clock
  let createDirectEVPRoute
  let discoverEVPProxy
  let log
  let setEventDeliveryStrategy
  let setWriterEnabledValue

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    createDirectEVPRoute = sinon.stub()
    discoverEVPProxy = sinon.stub()
    log = {
      debug: sinon.spy(),
      warn: sinon.spy(),
    }
    setWriterEnabledValue = sinon.spy()

    ;({ setEventDeliveryStrategy } = proxyquire('../../../src/openfeature/writers/util', {
      '../../evp_proxy/direct': { createDirectEVPRoute },
      '../../evp_proxy/discovery': { discoverEVPProxy },
      '../../log': log,
    }))
  })

  afterEach(() => {
    clock.restore()
  })

  it('keeps Remote Configuration on the historical fixed EVP v2 route', () => {
    const config = {
      url: new URL('http://localhost:8126/agent-prefix/'),
      featureFlags: { DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'remote_config' },
    }

    const stop = setEventDeliveryStrategy(config, setWriterEnabledValue)

    sinon.assert.calledOnceWithExactly(setWriterEnabledValue, true, {
      url: config.url,
      basePath: '/agent-prefix/evp_proxy/v2',
      headers: {
        'X-Datadog-EVP-Subdomain': 'event-platform-intake',
      },
    })
    sinon.assert.notCalled(discoverEVPProxy)
    sinon.assert.notCalled(createDirectEVPRoute)
    stop()
  })

  it('prefers v4 and requires both identity headers from an agentless local route', () => {
    const config = agentlessConfig()
    const directRoute = directEVPRoute()
    const localRoute = {
      url: config.url,
      basePath: '/evp_proxy/v4',
    }
    createDirectEVPRoute.returns(directRoute)
    discoverEVPProxy.yields(null, localRoute)

    const stop = setEventDeliveryStrategy(config, setWriterEnabledValue)

    sinon.assert.calledOnceWithExactly(discoverEVPProxy, config.url, {
      requiredHeaders: ['DD-EVP-ORIGIN', 'DD-EVP-ORIGIN-VERSION'],
      supportedPaths: ['/evp_proxy/v4', '/evp_proxy/v2'],
    }, sinon.match.func)
    sinon.assert.calledOnceWithExactly(setWriterEnabledValue, true, {
      ...localRoute,
      headers: {
        'X-Datadog-EVP-Subdomain': 'event-platform-intake',
      },
      fallback: directRoute,
      onFallback: sinon.match.func,
    })
    stop()
  })

  it('keeps direct routing sticky after local fallback', async () => {
    const config = agentlessConfig()
    const directRoute = directEVPRoute()
    createDirectEVPRoute.returns(directRoute)
    discoverEVPProxy.yields(null, {
      url: config.url,
      basePath: '/evp_proxy/v4',
    })

    const stop = setEventDeliveryStrategy(config, setWriterEnabledValue)
    const localRoute = setWriterEnabledValue.firstCall.args[1]
    localRoute.onFallback()
    localRoute.onFallback()
    await clock.tickAsync(120_000)

    sinon.assert.calledOnce(discoverEVPProxy)
    sinon.assert.calledTwice(setWriterEnabledValue)
    assert.deepStrictEqual(setWriterEnabledValue.secondCall.args, [true, directRoute])
    stop()
  })

  it('selects direct permanently when no compatible local route is available', async () => {
    const config = agentlessConfig()
    const directRoute = directEVPRoute()
    createDirectEVPRoute.returns(directRoute)
    discoverEVPProxy.yields(null)

    const stop = setEventDeliveryStrategy(config, setWriterEnabledValue)
    await clock.tickAsync(120_000)

    sinon.assert.calledOnce(discoverEVPProxy)
    sinon.assert.calledOnceWithExactly(setWriterEnabledValue, true, directRoute)
    stop()
  })

  it('recovers a local-only unavailable route after one bounded cooldown', async () => {
    const config = agentlessConfig()
    const localRoute = {
      url: config.url,
      basePath: '/evp_proxy/v2',
    }
    discoverEVPProxy.onFirstCall().yields(new Error('Agent starting'))
    discoverEVPProxy.onSecondCall().yields(null, localRoute)

    const stop = setEventDeliveryStrategy(config, setWriterEnabledValue)
    sinon.assert.calledOnceWithExactly(setWriterEnabledValue, false)

    await clock.tickAsync(59_999)
    sinon.assert.calledOnce(discoverEVPProxy)
    await clock.tickAsync(1)

    sinon.assert.calledTwice(discoverEVPProxy)
    assert.strictEqual(setWriterEnabledValue.secondCall.args[0], true)
    assert.strictEqual(setWriterEnabledValue.secondCall.args[1].url, localRoute.url)
    assert.strictEqual(setWriterEnabledValue.secondCall.args[1].basePath, localRoute.basePath)
    assert.strictEqual(typeof setWriterEnabledValue.secondCall.args[1].onUnavailable, 'function')
    stop()
  })

  it('schedules at most one unavailable-state recovery and cancels it on shutdown', async () => {
    const config = agentlessConfig()
    discoverEVPProxy.onFirstCall().yields(null, {
      url: config.url,
      basePath: '/evp_proxy/v4',
    })

    const stop = setEventDeliveryStrategy(config, setWriterEnabledValue)
    const route = setWriterEnabledValue.firstCall.args[1]
    route.onUnavailable()
    route.onUnavailable()
    stop()
    await clock.tickAsync(60_000)

    sinon.assert.calledOnce(discoverEVPProxy)
    assert.deepStrictEqual(setWriterEnabledValue.secondCall.args, [false])
  })

  it('warns once while unavailable without credentials', () => {
    discoverEVPProxy.yields(new Error('Agent unavailable'))
    const firstStop = setEventDeliveryStrategy(agentlessConfig(), setWriterEnabledValue)
    const secondStop = setEventDeliveryStrategy(agentlessConfig(), setWriterEnabledValue)

    sinon.assert.calledOnce(log.warn)
    assert.match(log.warn.firstCall.args[0], /direct intake credentials/)
    firstStop()
    secondStop()
  })
})

/**
 * @returns {object} Agentless tracer configuration
 */
function agentlessConfig () {
  return {
    url: new URL('http://serverless-init:8126'),
    featureFlags: { DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless' },
  }
}

/**
 * @returns {object} Direct EVP route
 */
function directEVPRoute () {
  return {
    url: new URL('https://event-platform-intake.datadoghq.com'),
    basePath: '',
    headers: { 'DD-API-KEY': 'test-api-key' },
  }
}
