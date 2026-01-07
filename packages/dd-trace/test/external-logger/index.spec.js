'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const nock = require('nock')

require('../setup/core')
const tracerLogger = require('../../src/log')

describe('External Logger', () => {
  let externalLogger
  let interceptor
  let errorLog

  beforeEach(() => {
    errorLog = sinon.spy(tracerLogger, 'error')

    const { ExternalLogger } = proxyquire('../../src/external-logger/src', {
      '../../log': {
        error: errorLog
      }
    })

    externalLogger = new ExternalLogger({
      ddsource: 'logging_from_space',
      hostname: 'mac_desktop',
      apiKey: 'API_KEY_PLACEHOLDER',
      interval: 10000,
      timeout: 5000,
      limit: 10
    })
  })

  afterEach(() => {
    interceptor.done()
    errorLog.restore()
  })

  it('should properly encode the log message', (done) => {
    let request
    const currentTime = Date.now()

    interceptor = nock('https://http-intake.logs.datadoghq.com:443')
      .post('/api/v2/logs')
      .reply((_uri, req, cb) => {
        request = req
        cb(null, [202, '{}', { 'Content-Type': 'application/json' }])
      })

    const span = {
      service: 'openAi',
      trace_id: '000001000',
      span_id: '9999991999'
    }
    const tags = {
      env: 'external_logger',
      version: '1.2.3',
      service: 'external'
    }
    externalLogger.log({
      message: 'oh no, something is up',
      custom: 'field',
      attribute: 'funky',
      service: 'outer_space',
      level: 'info'
    }, span, tags)

    externalLogger.flush((err) => {
      try {
        assert.strictEqual(request[0].message, 'oh no, something is up')
        assert.strictEqual(request[0].custom, 'field')
        assert.strictEqual(request[0].attribute, 'funky')
        assert.strictEqual(request[0].service, 'outer_space')
        assert.strictEqual(request[0].level, 'info')
        assert.strictEqual(request[0]['dd.trace_id'], '000001000')
        assert.strictEqual(request[0]['dd.span_id'], '9999991999')
        assert.ok(request[0].timestamp >= currentTime)
        assert.strictEqual(request[0].ddsource, 'logging_from_space')
        assert.strictEqual(request[0].ddtags, 'env:external_logger,version:1.2.3,service:external')
      } catch (e) {
        done(e)
        return
      }

      done(err)
    })
  })

  it('should empty the log queue when calling flush', (done) => {
    interceptor = nock('https://http-intake.logs.datadoghq.com:443')
      .post('/api/v2/logs')
      .reply(202, {})

    externalLogger.enqueue({})
    assert.strictEqual(externalLogger.queue.length, 1)

    externalLogger.flush((err) => {
      assert.strictEqual(externalLogger.queue.length, 0)
      done(err)
    })
  })

  it('tracer logger should handle error response codes from Logs API', (done) => {
    interceptor = nock('https://http-intake.logs.datadoghq.com:443')
      .post('/api/v2/logs')
      .reply(400, {})

    externalLogger.enqueue({})
    externalLogger.flush((err) => {
      assert.ok(err instanceof Error)
      assert.strictEqual(errorLog.getCall(0).args[0],
        'failed to send 1 logs, received response code 400'
      )
      done()
    })
  })

  it('tracer logger should handle simulated network error', (done) => {
    interceptor = nock('https://http-intake.logs.datadoghq.com:443')
      .post('/api/v2/logs')
      .replyWithError('missing API key')

    externalLogger.enqueue({})
    externalLogger.flush((err) => {
      assert.ok(err instanceof Error)
      assert.strictEqual(errorLog.getCall(0).args[0],
        'failed to send 1 log(s), with error missing API key'
      )
      done()
    })
  })

  it('causes a flush when exceeding log queue limit', (done) => {
    const flusher = sinon.stub(externalLogger, 'flush')

    for (let i = 0; i < 10; i++) {
      externalLogger.enqueue({})
    }
    sinon.assert.notCalled(flusher)

    externalLogger.enqueue({})
    sinon.assert.called(flusher)

    flusher.restore()
    done()
  })
})
