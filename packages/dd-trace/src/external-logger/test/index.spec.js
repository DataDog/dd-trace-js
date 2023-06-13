'use strict'

require('../../../../dd-trace/test/setup/tap')
const { expect } = require('chai')
const nock = require('nock')

describe('External Logger', function () {
  let externalLogger

  beforeEach(() => {
    const V2LogWriter = require('../src')

    externalLogger = new V2LogWriter({
      ddsource: 'logging_from_space',
      hostname: 'mac_desktop',
      apiKey: 'API_KEY_PLACEHOLDER',
      interval: 10000,
      timeout: 5000
    })

    const span = {
      meta: {
        openai: {
          endpoint: '',
          organization: {
            name: 'dd'
          },
          user: {
            api_key: 'ahifhkkv'
          }
        }
      },
      service: 'openAi',
      trace_id: '000001',
      span_id: '9999991'
    }

    const tags = {
      env: 'external_logger',
      version: '1.2.3',
      service: 'external',
      status: 'warn'
    }
    const log = externalLogger.log({
      message: 'oh no, something is up',
      arbitrary: 'field',
      attribute: 'funky',
      service: 'outer_space',
      level: 'info'
    }, span, tags)

    externalLogger.enqueue(log)
  })

  let scope
  before(() => {
    scope = nock('https://http-intake.logs.datadoghq.com:443', { 'encodedQueryParams': true })
      .post('/api/v2/logs')
      .reply(202, {}, [
        'Date',
        'Wed, 07 Jun 2023 21:06:45 GMT',
        'Content-Type',
        'application/json',
        'Content-Length',
        '2',
        'Connection',
        'keep-alive',
        'cross-origin-resource-policy',
        'cross-origin',
        'accept-encoding',
        'identity,gzip,x-gzip,deflate,x-deflate,zstd',
        'x-content-type-options',
        'nosniff',
        'strict-transport-security',
        'max-age=31536000; includeSubDomains; preload'
      ])
  })
  after(() => {
    nock.removeInterceptor(scope)
    externalLogger.shutdown()
  })

  it('should get a 202 response when posting a log', async (done) => {
    const result = nock('https://http-intake.logs.datadoghq.com:443')
      .post('/api/v2/logs')
      .reply(202, {})
    expect(result.interceptors[0].statusCode).to.equal(202)
    done()
  })

  it('calling flush should empty the buffer', (done) => {
    nock('https://http-intake.logs.datadoghq.com:443')
      .post('/api/v2/logs')
      .reply(202, {})

    expect(externalLogger.buffer.length).to.equal(1)
    externalLogger.flush()
    expect(externalLogger.buffer.length).to.equal(0)

    done()
  })
})
