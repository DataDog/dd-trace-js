'use strict'

const assert = require('node:assert/strict')

const { describe, it, afterEach } = require('mocha')
const nock = require('nock')

require('../../setup/core')
const ExposuresWriter = require('../../../src/openfeature/writers/exposures')

describe('OpenFeature agentless exposures transport', () => {
  let writer

  afterEach(() => {
    writer?.destroy()
    nock.cleanAll()
  })

  it('sends exposure events directly to the site intake', async () => {
    const requestReceived = new Promise((resolve, reject) => {
      nock('https://event-platform-intake.us3.datadoghq.com', {
        reqheaders: {
          'content-type': 'application/json',
          'dd-api-key': 'test-api-key',
        },
        badheaders: ['x-datadog-evp-subdomain'],
      })
        .post('/api/v2/exposures')
        .reply(202, (uri, body) => {
          try {
            assert.strictEqual(uri, '/api/v2/exposures')
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

    writer = new ExposuresWriter({
      DD_AGENTLESS_ENABLED: true,
      DD_API_KEY: 'test-api-key',
      site: 'us3.datadoghq.com',
      service: 'test-service',
      url: new URL('http://127.0.0.1:8126'),
    })
    writer.setEnabled(true)
    writer.append({
      timestamp: 1672531200000,
      allocation: { key: 'allocation' },
      flag: { key: 'checkout' },
      variant: { key: 'enabled' },
      subject: { id: 'customer-1' },
    })
    writer.flush()

    await requestReceived
    assert.strictEqual(nock.isDone(), true)
  })
})
