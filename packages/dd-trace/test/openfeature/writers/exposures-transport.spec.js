'use strict'

const assert = require('node:assert/strict')

const { describe, it, afterEach } = require('mocha')
const nock = require('nock')

require('../../setup/core')
const { clearCache } = require('../../../src/agent/info')
const ExposuresWriter = require('../../../src/openfeature/writers/exposures')
const { setExposureDeliveryStrategy } = require('../../../src/openfeature/writers/util')

describe('OpenFeature Exposures Writer transport', () => {
  let writer

  afterEach(() => {
    writer?.destroy()
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
        evp_proxy_allowed_headers: ['Content-Type', 'Accept-Encoding'],
      })

    const requestReceived = new Promise((resolve, reject) => {
      nock('http://localhost:8126', {
        reqheaders: {
          'content-type': 'application/json',
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
      setExposureDeliveryStrategy(config, (enabled, route) => {
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
      .reply(200, { endpoints: ['/evp_proxy/v4'] })
    const localRequest = nock('http://localhost:8126')
      .post('/evp_proxy/v4/api/v2/exposures')
      .reply(405)

    const directRequestReceived = new Promise(resolve => {
      nock('https://event-platform-intake.datadoghq.com', {
        reqheaders: {
          'content-type': 'application/json',
          'dd-api-key': 'test-api-key',
        },
      })
        .post('/api/v2/exposures')
        .reply(202, () => {
          resolve()
          return ''
        })
    })

    writer = new ExposuresWriter(config)
    await new Promise((resolve, reject) => {
      setExposureDeliveryStrategy(config, (enabled, route) => {
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

    const directRequestReceived = new Promise(resolve => {
      nock('https://event-platform-intake.datadoghq.com', {
        reqheaders: {
          'content-type': 'application/json',
          'dd-api-key': 'test-api-key',
        },
      })
        .post('/api/v2/exposures')
        .reply(202, () => {
          resolve()
          return ''
        })
    })

    writer = new ExposuresWriter(config)
    await new Promise((resolve, reject) => {
      setExposureDeliveryStrategy(config, (enabled, route) => {
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
  })
})
