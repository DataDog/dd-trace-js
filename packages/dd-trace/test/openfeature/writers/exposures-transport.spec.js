'use strict'

const assert = require('node:assert/strict')

const { describe, it, afterEach } = require('mocha')
const nock = require('nock')

require('../../setup/core')
const { clearCache } = require('../../../src/agent/info')
const ExposuresWriter = require('../../../src/openfeature/writers/exposures')
const { setExposureDeliveryStrategy } = require('../../../src/openfeature/writers/util')
const tracerVersion = require('../../../../../package.json').version

describe('OpenFeature Exposures Writer transport', () => {
  let writer
  let stopDeliveryStrategy

  afterEach(() => {
    writer?.destroy()
    stopDeliveryStrategy?.()
    clearCache()
    nock.cleanAll()
  })

  it('should use local EVP when allowed headers omit the Agent-consumed routing header', async () => {
    const config = {
      url: new URL('http://localhost:8126'),
      site: 'datadoghq.com',
      DD_API_KEY: 'test-api-key',
      service: 'test-service',
      featureFlags: { DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless' },
    }
    const infoRequest = nock('http://localhost:8126')
      .get('/info')
      .reply(200, {
        endpoints: ['/evp_proxy/v4/', '/evp_proxy/v2/'],
        evp_proxy_allowed_headers: ['DD-EVP-ORIGIN', 'dd-evp-origin-version'],
      })

    const requestReceived = new Promise((resolve, reject) => {
      nock('http://localhost:8126', {
        reqheaders: {
          'content-type': 'application/json',
          'dd-evp-origin': 'dd-trace-js',
          'dd-evp-origin-version': tracerVersion,
          'x-datadog-evp-subdomain': 'event-platform-intake',
        },
      })
        .post('/evp_proxy/v4/api/v2/exposures')
        .reply(202, (uri, body) => {
          try {
            assert.strictEqual(uri, '/evp_proxy/v4/api/v2/exposures')
            assert.strictEqual(body.context.service, 'test-service')
            assert.strictEqual(body.exposures.length, 1)
            assert.strictEqual(body.exposures[0].flag.key, 'checkout')
            resolve()
          } catch (error) {
            reject(error)
          }
          return ''
        })
    })

    writer = new ExposuresWriter(config)
    await new Promise((resolve, reject) => {
      stopDeliveryStrategy = setExposureDeliveryStrategy(config, (enabled, route) => {
        try {
          assert.strictEqual(enabled, true)
          assert.strictEqual(route.basePath, '/evp_proxy/v4')
          writer.setEnabled(enabled, route)
          resolve()
        } catch (error) {
          reject(error)
        }
      })
    })
    infoRequest.done()

    writer.append({
      timestamp: 1672531200000,
      allocation: { key: 'allocation' },
      flag: { key: 'checkout' },
      variant: { key: 'enabled' },
      subject: { id: 'customer-1' },
    })
    writer.flush()

    await requestReceived
  })

  it('should retry direct after a local EVP 405 response', async () => {
    const config = {
      url: new URL('http://localhost:8126'),
      site: 'datadoghq.com',
      DD_API_KEY: 'test-api-key',
      service: 'test-service',
      featureFlags: { DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless' },
    }
    const infoRequest = nock('http://localhost:8126')
      .get('/info')
      .reply(200, {
        endpoints: ['/evp_proxy/v4'],
        evp_proxy_allowed_headers: ['DD-EVP-ORIGIN', 'DD-EVP-ORIGIN-VERSION'],
      })
    const localRequest = nock('http://localhost:8126')
      .post('/evp_proxy/v4/api/v2/exposures')
      .reply(405)

    let directHeaders
    const directRequestReceived = new Promise(resolve => {
      nock('https://event-platform-intake.datadoghq.com', {
        reqheaders: {
          'content-type': 'application/json',
          'dd-api-key': 'test-api-key',
          'dd-evp-origin': 'dd-trace-js',
          'dd-evp-origin-version': tracerVersion,
        },
      })
        .post('/api/v2/exposures')
        .reply(202, function () {
          directHeaders = this.req.headers
          resolve()
          return ''
        })
    })

    writer = new ExposuresWriter(config)
    await new Promise((resolve, reject) => {
      stopDeliveryStrategy = setExposureDeliveryStrategy(config, (enabled, route) => {
        try {
          assert.strictEqual(enabled, true)
          assert.strictEqual(route.basePath, '/evp_proxy/v4')
          assert.strictEqual(route.fallback.basePath, '')
          writer.setEnabled(enabled, route)
          resolve()
        } catch (error) {
          reject(error)
        }
      })
    })
    infoRequest.done()

    writer.append({
      timestamp: 1672531200000,
      allocation: { key: 'allocation' },
      flag: { key: 'checkout' },
      variant: { key: 'enabled' },
      subject: { id: 'customer-1' },
    })
    writer.flush()

    await directRequestReceived
    assert.strictEqual(directHeaders['dd-api-key'], 'test-api-key')
    assert.strictEqual(directHeaders['x-datadog-evp-subdomain'], undefined)
    localRequest.done()
  })

  it('should send direct when no local receiver is listening', async () => {
    const config = {
      url: new URL('http://127.0.0.1:9'),
      site: 'datadoghq.com',
      DD_API_KEY: 'test-api-key',
      service: 'test-service',
      featureFlags: { DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless' },
    }
    const infoRequest = nock('http://127.0.0.1:9')
      .get('/info')
      .replyWithError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))

    let directHeaders
    const directRequestReceived = new Promise(resolve => {
      nock('https://event-platform-intake.datadoghq.com', {
        reqheaders: {
          'content-type': 'application/json',
          'dd-api-key': 'test-api-key',
          'dd-evp-origin': 'dd-trace-js',
          'dd-evp-origin-version': tracerVersion,
        },
      })
        .post('/api/v2/exposures')
        .reply(202, function () {
          directHeaders = this.req.headers
          resolve()
          return ''
        })
    })

    writer = new ExposuresWriter(config)
    await new Promise((resolve, reject) => {
      stopDeliveryStrategy = setExposureDeliveryStrategy(config, (enabled, route) => {
        try {
          assert.strictEqual(enabled, true)
          assert.strictEqual(route.basePath, '')
          writer.setEnabled(enabled, route)
          resolve()
        } catch (error) {
          reject(error)
        }
      })
    })
    infoRequest.done()

    writer.append({
      timestamp: 1672531200000,
      allocation: { key: 'allocation' },
      flag: { key: 'checkout' },
      variant: { key: 'enabled' },
      subject: { id: 'customer-1' },
    })
    writer.flush()

    await directRequestReceived
    assert.strictEqual(directHeaders['dd-api-key'], 'test-api-key')
    assert.strictEqual(directHeaders['dd-evp-origin'], 'dd-trace-js')
    assert.strictEqual(directHeaders['dd-evp-origin-version'], tracerVersion)
    assert.strictEqual(directHeaders['x-datadog-evp-subdomain'], undefined)
  })

  it('preserves the configured Agent path prefix without leaking the API key locally', async () => {
    const config = {
      url: new URL('http://localhost:8126/agent-prefix/'),
      site: 'datadoghq.com',
      DD_API_KEY: 'test-api-key',
      service: 'test-service',
      featureFlags: { DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless' },
    }
    const infoRequest = nock('http://localhost:8126')
      .get('/agent-prefix/info')
      .reply(200, {
        endpoints: ['/evp_proxy/v2'],
        evp_proxy_allowed_headers: ['DD-EVP-ORIGIN', 'DD-EVP-ORIGIN-VERSION'],
      })
    let localHeaders
    const localRequest = nock('http://localhost:8126')
      .post('/agent-prefix/evp_proxy/v2/api/v2/exposures')
      .reply(function () {
        localHeaders = this.req.headers
        return [202, '']
      })

    writer = new ExposuresWriter(config)
    await new Promise((resolve, reject) => {
      stopDeliveryStrategy = setExposureDeliveryStrategy(config, (enabled, route) => {
        try {
          writer.setEnabled(enabled, route)
          resolve()
        } catch (error) {
          reject(error)
        }
      })
    })
    infoRequest.done()

    writer.append({
      timestamp: 1672531200000,
      allocation: { key: 'allocation' },
      flag: { key: 'prefix' },
      variant: { key: 'enabled' },
      subject: { id: 'customer-1' },
    })
    writer.flush()

    await waitFor(() => localHeaders !== undefined)
    localRequest.done()
    assert.strictEqual(localHeaders['dd-api-key'], undefined)
    assert.strictEqual(localHeaders['dd-evp-origin'], 'dd-trace-js')
    assert.strictEqual(localHeaders['dd-evp-origin-version'], tracerVersion)
    assert.strictEqual(localHeaders['x-datadog-evp-subdomain'], 'event-platform-intake')
  })

  it('does not follow a direct-intake redirect or forward credentials to its target', async () => {
    const config = {
      url: new URL('http://127.0.0.1:9'),
      site: 'datadoghq.com',
      DD_API_KEY: 'test-api-key',
      service: 'test-service',
      featureFlags: { DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless' },
    }
    const infoRequest = nock('http://127.0.0.1:9')
      .get('/info')
      .replyWithError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    const directRequest = nock('https://event-platform-intake.datadoghq.com')
      .post('/api/v2/exposures')
      .reply(302, '', { location: 'https://redirected.example/api/v2/exposures' })
    const redirectedRequest = nock('https://redirected.example')
      .post('/api/v2/exposures')
      .reply(202)

    writer = new ExposuresWriter(config)
    await new Promise((resolve, reject) => {
      stopDeliveryStrategy = setExposureDeliveryStrategy(config, (enabled, route) => {
        try {
          writer.setEnabled(enabled, route)
          resolve()
        } catch (error) {
          reject(error)
        }
      })
    })
    infoRequest.done()

    writer.append({
      timestamp: 1672531200000,
      allocation: { key: 'allocation' },
      flag: { key: 'redirect' },
      variant: { key: 'enabled' },
      subject: { id: 'customer-1' },
    })
    writer.flush()

    await waitFor(() => directRequest.isDone())
    directRequest.done()
    assert.strictEqual(redirectedRequest.isDone(), false)
  })
})

/**
 * @param {() => boolean} predicate - Completion predicate
 * @returns {Promise<void>}
 */
async function waitFor (predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('Timed out waiting for request')
}
