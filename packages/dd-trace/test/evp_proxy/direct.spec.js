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
        'DD-API-KEY-FINGERPRINT': 'rijn_i8Jug5ocjALL7JZiV1a8HzXqkwDRKcE7hK9IouPQwio',
      },
    })
  })

  for (const [apiKey, fingerprint] of [
    ['padding-171', 'rijn_053ybBRXypQt9AC6UIlqH1YCFYSV1rQl8HCDIcBZs3D'],
    ['!@#$%^𐍈한€हИ£', 'rijn_eFLHeyLxwaiNs2hY16pjkjNjVSHWRgf2rlveKc8YA1K'],
    ['secret', 'rijn_amLaG4Pd6h6t9VtJna81k744P1DYxGHzIJ6ECO3OOMj'],
    ['system-tests-mock-api-key', 'rijn_Fc1Sxm6lPHiKU1IdWeNqpcVZiiW3C2LXJLqQp670sFU'],
  ]) {
    it(`creates the canonical fixed-width fingerprint for ${JSON.stringify(apiKey)}`, () => {
      const route = createDirectEVPRoute({
        DD_API_KEY: apiKey,
        site: 'datadoghq.com',
      }, 'event-platform-intake')

      assert.strictEqual(route.headers['DD-API-KEY-FINGERPRINT'], fingerprint)
      assert.strictEqual(route.headers['DD-API-KEY-FINGERPRINT'].length, 48)
    })
  }

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
        'DD-API-KEY-FINGERPRINT': 'rijn_i8Jug5ocjALL7JZiV1a8HzXqkwDRKcE7hK9IouPQwio',
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

  for (const site of [
    'datadoghq.com@evil.example',
    'datadoghq.com:password@evil.example',
    'datadoghq.com:443',
    'datadoghq.com/path',
    'datadoghq.com?query',
    'datadoghq.com#fragment',
  ]) {
    it(`does not create a route for a site with URL components: ${site}`, () => {
      assert.strictEqual(createDirectEVPRoute({
        DD_API_KEY: 'test-api-key',
        site,
      }, 'event-platform-intake'), undefined)

      sinon.assert.calledOnceWithExactly(
        log.debug,
        'Unable to configure direct EVP intake: %s',
        sinon.match.string
      )
    })
  }
})
