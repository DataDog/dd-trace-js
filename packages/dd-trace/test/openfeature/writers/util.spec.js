'use strict'

const assert = require('node:assert/strict')
const { format } = require('node:util')

const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

require('../../setup/core')

describe('OpenFeature event delivery strategy', () => {
  let createDirectEVPRoute
  let discoverEVPProxy
  let log
  let setEventDeliveryStrategy
  let setWriterEnabledValue

  beforeEach(() => {
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

  it('preserves Agent EVP v2 discovery for Remote Configuration', () => {
    const config = {
      url: new URL('http://localhost:8126'),
      featureFlags: { DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'remote_config' },
    }
    const route = {
      url: config.url,
      basePath: '/evp_proxy/v2',
    }
    discoverEVPProxy.yields(null, route)

    setEventDeliveryStrategy(config, setWriterEnabledValue)

    sinon.assert.calledOnceWithExactly(discoverEVPProxy, config.url, {
      supportedPaths: ['/evp_proxy/v2'],
    }, sinon.match.func)
    sinon.assert.calledOnceWithExactly(setWriterEnabledValue, true, route)
    sinon.assert.notCalled(createDirectEVPRoute)
  })

  it('disables Remote Configuration event delivery when discovery fails', () => {
    discoverEVPProxy.yields(new Error('Agent unavailable'))

    setEventDeliveryStrategy({
      url: new URL('http://localhost:8126'),
      featureFlags: { DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'remote_config' },
    }, setWriterEnabledValue)

    sinon.assert.calledOnceWithExactly(setWriterEnabledValue, false)
    assert.match(log.debug.firstCall.args[0], /error getting agent info/)
  })

  it('prefers an advertised agentless EVP v4 route and keeps direct fallback', () => {
    const config = {
      url: new URL('http://serverless-init:8126'),
      featureFlags: { DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless' },
    }
    const localRoute = {
      url: config.url,
      basePath: '/evp_proxy/v4',
    }
    const directRoute = {
      url: new URL('https://event-platform-intake.datadoghq.com'),
      basePath: '',
      headers: { 'DD-API-KEY': 'test-api-key' },
    }
    createDirectEVPRoute.returns(directRoute)
    discoverEVPProxy.yields(null, localRoute)

    setEventDeliveryStrategy(config, setWriterEnabledValue)

    sinon.assert.calledOnceWithExactly(discoverEVPProxy, config.url, {
      retry: false,
      supportedPaths: ['/evp_proxy/v4', '/evp_proxy/v2'],
    }, sinon.match.func)
    sinon.assert.calledOnceWithExactly(setWriterEnabledValue, true, {
      ...localRoute,
      headers: {
        'X-Datadog-EVP-Subdomain': 'event-platform-intake',
      },
      fallback: directRoute,
    })
  })

  it('accepts an advertised agentless route without requiring forwarded routing headers', () => {
    const config = {
      url: new URL('http://serverless-init:8126'),
      featureFlags: { DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless' },
    }
    discoverEVPProxy.yields(null, {
      url: config.url,
      basePath: '/evp_proxy/v2',
    })

    setEventDeliveryStrategy(config, setWriterEnabledValue)

    sinon.assert.calledOnceWithExactly(discoverEVPProxy, config.url, {
      retry: false,
      supportedPaths: ['/evp_proxy/v4', '/evp_proxy/v2'],
    }, sinon.match.func)
    sinon.assert.calledOnceWithMatch(setWriterEnabledValue, true, {
      basePath: '/evp_proxy/v2',
    })
  })

  it('uses direct intake when no compatible local route is advertised', () => {
    const config = {
      url: new URL('http://localhost:8126'),
      featureFlags: { DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless' },
    }
    const directRoute = {
      url: new URL('https://event-platform-intake.datadoghq.com'),
      basePath: '',
      headers: { 'DD-API-KEY': 'test-api-key' },
    }
    createDirectEVPRoute.returns(directRoute)
    discoverEVPProxy.yields(null)

    setEventDeliveryStrategy(config, setWriterEnabledValue)

    sinon.assert.calledOnceWithExactly(setWriterEnabledValue, true, directRoute)
    sinon.assert.notCalled(log.warn)
  })

  it('uses direct intake when no local receiver is listening', () => {
    const config = {
      url: new URL('http://127.0.0.1:9'),
      featureFlags: { DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless' },
    }
    const directRoute = {
      url: new URL('https://event-platform-intake.datadoghq.com'),
      basePath: '',
      headers: { 'DD-API-KEY': 'test-api-key' },
    }
    createDirectEVPRoute.returns(directRoute)
    discoverEVPProxy.yields(new Error('connect ECONNREFUSED'))

    setEventDeliveryStrategy(config, setWriterEnabledValue)

    sinon.assert.calledOnceWithExactly(setWriterEnabledValue, true, directRoute)
    sinon.assert.notCalled(log.warn)
    assert.match(format(...log.debug.firstCall.args), /local discovery failed/)
  })

  it('shares one discovery result with every event writer', () => {
    const config = {
      url: new URL('http://serverless-init:8126'),
      featureFlags: { DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless' },
    }
    const route = {
      url: config.url,
      basePath: '/evp_proxy/v4',
    }
    const firstWriter = sinon.spy()
    const secondWriter = sinon.spy()
    let resolveDiscovery
    discoverEVPProxy.callsFake((url, options, callback) => {
      resolveDiscovery = callback
    })

    setEventDeliveryStrategy(config, firstWriter)
    setEventDeliveryStrategy(config, secondWriter)
    sinon.assert.calledOnce(discoverEVPProxy)

    resolveDiscovery(null, route)
    sinon.assert.calledOnceWithMatch(firstWriter, true, { basePath: '/evp_proxy/v4' })
    sinon.assert.calledOnceWithMatch(secondWriter, true, { basePath: '/evp_proxy/v4' })

    const lateWriter = sinon.spy()
    setEventDeliveryStrategy(config, lateWriter)
    sinon.assert.calledOnceWithMatch(lateWriter, true, { basePath: '/evp_proxy/v4' })
    sinon.assert.calledOnce(discoverEVPProxy)
  })

  it('disables delivery and warns when no local route or direct credentials exist', () => {
    discoverEVPProxy.yields(new Error('connect ECONNREFUSED'))

    setEventDeliveryStrategy({
      url: new URL('http://127.0.0.1:9'),
      featureFlags: { DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless' },
    }, setWriterEnabledValue)

    sinon.assert.calledOnceWithExactly(setWriterEnabledValue, false)
    sinon.assert.calledOnce(log.warn)
    assert.match(format(...log.warn.firstCall.args), /direct intake credentials/)
  })

  it('logs the unavailable event-delivery warning once', () => {
    discoverEVPProxy.yields(new Error('connect ECONNREFUSED'))
    const config = {
      url: new URL('http://127.0.0.1:9'),
      featureFlags: { DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless' },
    }

    setEventDeliveryStrategy(config, setWriterEnabledValue)
    setEventDeliveryStrategy(config, setWriterEnabledValue)

    sinon.assert.calledTwice(setWriterEnabledValue)
    sinon.assert.calledOnce(log.warn)
  })
})
