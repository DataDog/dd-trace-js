'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

describe('direct EVP route', () => {
  let createDirectEVPRoute
  let getProxyForUrl
  let HttpsProxyAgent
  let log

  beforeEach(() => {
    getProxyForUrl = sinon.stub().returns('')
    HttpsProxyAgent = sinon.stub().callsFake(proxyUrl => ({ proxyUrl }))
    log = { debug: sinon.spy() }

    ;({ createDirectEVPRoute } = proxyquire('../../src/evp_proxy/direct', {
      '../../../../vendor/dist/https-proxy-agent': { HttpsProxyAgent },
      '../../../../vendor/dist/proxy-from-env': { getProxyForUrl },
      '../log': log,
    }))
  })

  it('creates an authenticated route from API key and site', () => {
    const route = createDirectEVPRoute({
      DD_API_KEY: 'test-api-key',
      site: 'datadoghq.com',
    }, 'event-platform-intake')

    assert.deepStrictEqual(route, {
      url: new URL('https://event-platform-intake.datadoghq.com'),
      basePath: '',
      headers: {
        'DD-API-KEY': 'test-api-key',
      },
    })
  })

  it('normalizes site casing', () => {
    const route = createDirectEVPRoute({
      DD_API_KEY: 'test-api-key',
      site: 'DATADOGHQ.EU',
    }, 'event-platform-intake')

    assert.deepStrictEqual(route, {
      url: new URL('https://event-platform-intake.datadoghq.eu'),
      basePath: '',
      headers: {
        'DD-API-KEY': 'test-api-key',
      },
    })
  })

  it('uses the standard HTTPS proxy for direct intake', () => {
    const proxyUrl = 'http://proxy:8202'
    getProxyForUrl.returns(proxyUrl)

    const route = createDirectEVPRoute({
      DD_API_KEY: 'test-api-key',
      site: 'datadoghq.com',
    }, 'event-platform-intake')

    assert.deepStrictEqual(route.agent, { proxyUrl })
    sinon.assert.calledOnceWithExactly(
      getProxyForUrl,
      'https://event-platform-intake.datadoghq.com/'
    )
    sinon.assert.calledOnceWithExactly(HttpsProxyAgent, proxyUrl)
  })

  it('does not create a route without an API key', () => {
    assert.strictEqual(createDirectEVPRoute({
      site: 'datadoghq.com',
    }, 'event-platform-intake'), undefined)
  })

  it('does not create a route without a site', () => {
    assert.strictEqual(createDirectEVPRoute({
      DD_API_KEY: 'test-api-key',
    }, 'event-platform-intake'), undefined)
  })

  it('does not create a route for an invalid site', () => {
    assert.strictEqual(createDirectEVPRoute({
      DD_API_KEY: 'test-api-key',
      site: 'not a host',
    }, 'event-platform-intake'), undefined)

    sinon.assert.calledOnceWithExactly(
      log.debug,
      'Unable to configure direct EVP intake: %s',
      sinon.match.string
    )
  })
})
