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

  it('checks Remote Configuration capability once and keeps the fixed EVP v2 route', () => {
    const config = {
      url: new URL('http://localhost:8126/agent-prefix/'),
      DD_API_KEY: 'test-api-key',
      featureFlags: { DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'remote_config' },
    }
    const localRoute = { url: config.url, basePath: '/agent-prefix/evp_proxy/v2' }
    discoverEVPProxy.yields(null, localRoute)

    const stop = setEventDeliveryStrategy(config, setWriterEnabledValue)

    sinon.assert.calledOnceWithExactly(discoverEVPProxy, config.url, {
      supportedPaths: ['/evp_proxy/v2'],
    }, sinon.match.func)
    sinon.assert.calledOnceWithExactly(setWriterEnabledValue, true, localRoute)
    sinon.assert.notCalled(createDirectEVPRoute)
    stop()
  })

  it('waits for the Agent capability result before enabling the default delivery strategy', () => {
    const config = { url: new URL('http://localhost:8126') }
    const stop = setEventDeliveryStrategy(config, setWriterEnabledValue)

    sinon.assert.notCalled(setWriterEnabledValue)
    const localRoute = { url: config.url, basePath: '/evp_proxy/v2' }
    discoverEVPProxy.firstCall.args[2](null, localRoute)

    sinon.assert.calledOnceWithExactly(setWriterEnabledValue, true, localRoute)
    sinon.assert.notCalled(createDirectEVPRoute)
    stop()
  })

  for (const error of [null, new Error('Agent unavailable')]) {
    it(`disables Remote Configuration delivery on ${error ? 'discovery error' : 'missing EVP v2'}`, async () => {
      const config = {
        url: new URL('http://localhost:8126'),
        DD_API_KEY: 'test-api-key',
        featureFlags: { DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'remote_config' },
      }
      discoverEVPProxy.yields(error)

      const stop = setEventDeliveryStrategy(config, setWriterEnabledValue)
      await clock.tickAsync(120_000)

      sinon.assert.calledOnceWithExactly(setWriterEnabledValue, false)
      sinon.assert.calledOnce(discoverEVPProxy)
      sinon.assert.notCalled(createDirectEVPRoute)
      sinon.assert.calledOnce(log.debug)
      stop()
    })
  }

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
      retry: false,
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

  it('shares discovery and sticky fallback between both subscribers, including a late subscriber', () => {
    const config = agentlessConfig()
    const directRoute = directEVPRoute()
    const otherWriter = sinon.spy()
    createDirectEVPRoute.returns(directRoute)

    const stop = setEventDeliveryStrategy(config, setWriterEnabledValue)
    const stopOther = setEventDeliveryStrategy(config, otherWriter)
    sinon.assert.calledOnce(discoverEVPProxy)
    discoverEVPProxy.firstCall.args[2](null, { url: config.url, basePath: '/evp_proxy/v4' })

    const localRoute = setWriterEnabledValue.firstCall.args[1]
    assert.strictEqual(otherWriter.firstCall.args[1], localRoute)
    localRoute.onFallback()
    sinon.assert.calledWithExactly(setWriterEnabledValue, true, directRoute)
    sinon.assert.calledWithExactly(otherWriter, true, directRoute)

    const lateWriter = sinon.spy()
    const stopLate = setEventDeliveryStrategy(config, lateWriter)
    sinon.assert.calledOnceWithExactly(lateWriter, true, directRoute)
    sinon.assert.calledOnce(discoverEVPProxy)
    stop()
    stopOther()
    stopLate()
  })

  it('keeps one recovery alive for the remaining consumer and stops it after the last unsubscribe', async () => {
    const config = agentlessConfig()
    const otherWriter = sinon.spy()
    discoverEVPProxy.yields(new Error('Receiver unavailable'))
    const stop = setEventDeliveryStrategy(config, setWriterEnabledValue)
    const stopOther = setEventDeliveryStrategy(config, otherWriter)
    sinon.assert.calledOnce(discoverEVPProxy)
    sinon.assert.calledOnceWithExactly(otherWriter, false)
    assert.strictEqual(clock.countTimers(), 1)

    stop()
    stop()
    discoverEVPProxy.onSecondCall().yields(null, { url: config.url, basePath: '/evp_proxy/v4' })
    await clock.tickAsync(60_000)
    sinon.assert.calledTwice(discoverEVPProxy)
    sinon.assert.calledOnce(setWriterEnabledValue)
    assert.strictEqual(otherWriter.secondCall.args[0], true)

    otherWriter.secondCall.args[1].onUnavailable()
    assert.strictEqual(clock.countTimers(), 1)
    stopOther()
    assert.strictEqual(clock.countTimers(), 0)
    await clock.tickAsync(60_000)
    sinon.assert.calledTwice(discoverEVPProxy)
  })

  for (const source of ['remote_config', 'agentless']) {
    it(`ignores stale ${source} discovery after the last consumer closes and starts fresh on reuse`, () => {
      const config = agentlessConfig()
      config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE = source
      const otherWriter = sinon.spy()
      const stop = setEventDeliveryStrategy(config, setWriterEnabledValue)
      const stopOther = setEventDeliveryStrategy(config, otherWriter)
      stop()
      stopOther()

      const newWriter = sinon.spy()
      const stopNew = setEventDeliveryStrategy(config, newWriter)
      sinon.assert.calledTwice(discoverEVPProxy)
      discoverEVPProxy.firstCall.args[2](null, { url: config.url, basePath: '/evp_proxy/v2' })
      sinon.assert.notCalled(setWriterEnabledValue)
      sinon.assert.notCalled(otherWriter)
      sinon.assert.notCalled(newWriter)
      discoverEVPProxy.secondCall.args[2](null, { url: config.url, basePath: '/evp_proxy/v2' })
      sinon.assert.calledOnce(newWriter)
      stopNew()
    })
  }

  it('never shares routes or credentials across separate tracer configurations', () => {
    const firstConfig = agentlessConfig()
    const secondConfig = { ...agentlessConfig(), DD_API_KEY: 'different-api-key' }
    const otherWriter = sinon.spy()
    const directRoute = directEVPRoute()
    createDirectEVPRoute.withArgs(secondConfig).returns(directRoute)
    discoverEVPProxy.yields(null)

    const stop = setEventDeliveryStrategy(firstConfig, setWriterEnabledValue)
    const stopOther = setEventDeliveryStrategy(secondConfig, otherWriter)
    sinon.assert.calledTwice(discoverEVPProxy)
    sinon.assert.calledOnceWithExactly(setWriterEnabledValue, false)
    sinon.assert.calledOnceWithExactly(otherWriter, true, directRoute)
    stop()
    stopOther()
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
