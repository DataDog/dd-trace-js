'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

describe('direct EVP route', () => {
  let createDirectEVPRoute
  let log

  beforeEach(() => {
    log = { warn: sinon.spy() }

    ;({ createDirectEVPRoute } = proxyquire('../../src/evp_proxy/direct', {
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

  it('normalizes surrounding whitespace and defaults a blank site', () => {
    assert.strictEqual(createDirectEVPRoute({
      DD_API_KEY: 'test-api-key',
      site: '  DATADOGHQ.EU  ',
    }, 'event-platform-intake').url.href, 'https://event-platform-intake.datadoghq.eu/')

    assert.strictEqual(createDirectEVPRoute({
      DD_API_KEY: 'test-api-key',
      site: '  ',
    }, 'event-platform-intake').url.href, 'https://event-platform-intake.datadoghq.com/')
  })

  it('does not create a route without an API key', () => {
    assert.strictEqual(createDirectEVPRoute({
      site: 'datadoghq.com',
    }, 'event-platform-intake'), undefined)
  })

  it('uses the default site when it is omitted', () => {
    const route = createDirectEVPRoute({
      DD_API_KEY: 'test-api-key',
    }, 'event-platform-intake')

    assert.strictEqual(route.url.href, 'https://event-platform-intake.datadoghq.com/')
  })

  it('does not create a route for an invalid site', () => {
    assert.strictEqual(createDirectEVPRoute({
      DD_API_KEY: 'test-api-key',
      site: 'not a host',
    }, 'event-platform-intake'), undefined)

    sinon.assert.calledOnceWithExactly(
      log.warn,
      'Feature Flags direct event delivery is disabled because DD_SITE is invalid.'
    )
  })

  it('warns once without logging an invalid site or API key', () => {
    const config = {
      DD_API_KEY: 'sensitive-api-key',
      site: 'sensitive invalid site',
    }

    createDirectEVPRoute(config, 'event-platform-intake')
    createDirectEVPRoute(config, 'event-platform-intake')

    sinon.assert.calledOnce(log.warn)
    const message = log.warn.firstCall.args.join(' ')
    assert.ok(!message.includes(config.site))
    assert.ok(!message.includes(config.DD_API_KEY))
  })
})
