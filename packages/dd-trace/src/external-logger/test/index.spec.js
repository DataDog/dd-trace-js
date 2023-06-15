'use strict'

require('../../../../dd-trace/test/setup/tap')
const proxyquire = require('proxyquire')
const { expect } = require('chai')
const nock = require('nock')

const tracerLogger = require('../../log')

describe('External Logger', () => {
  let externalLogger
  let interceptor
  let errorLog

  beforeEach(() => {
    const V2LogWriter = require('../src')

    externalLogger = new V2LogWriter({
      ddsource: 'logging_from_space',
      hostname: 'mac_desktop',
      apiKey: 'API_KEY_PLACEHOLDER',
      interval: 10000,
      timeout: 5000
    })

    errorLog = sinon.spy(tracerLogger, 'error')
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
        cb(null, [202, '{}', {
          'Content-Type': 'application/json'
        }])
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
    const log = externalLogger.log({
      message: 'oh no, something is up',
      custom: 'field',
      attribute: 'funky',
      service: 'outer_space',
      level: 'info'
    }, span, tags)

    externalLogger.enqueue(log)
    externalLogger.flush((err) => {
      try {
        expect(request[0]).to.have.property('message', 'oh no, something is up')
        expect(request[0]).to.have.property('custom', 'field')
        expect(request[0]).to.have.property('attribute', 'funky')
        expect(request[0]).to.have.property('service', 'outer_space')
        expect(request[0]).to.have.property('level', 'info')
        expect(request[0]).to.have.property('dd.trace_id', '000001000')
        expect(request[0]).to.have.property('dd.span_id', '9999991999')
        expect(request[0].timestamp).to.be.greaterThanOrEqual(currentTime)
        expect(request[0]).to.have.property('ddsource', 'logging_from_space')
        expect(request[0]).to.have.property('ddtags', 'env:external_logger,version:1.2.3,service:external')
      } catch (e) {
        done(e)
        return
      }

      done(err)
    })
  })

  it('should empty the buffer when calling flush', (done) => {
    interceptor = nock('https://http-intake.logs.datadoghq.com:443')
      .post('/api/v2/logs')
      .reply(202, {})

    externalLogger.enqueue({})
    expect(externalLogger.buffer.length).to.equal(1)

    externalLogger.flush((err) => {
      expect(externalLogger.buffer.length).to.equal(0)
      done(err)
    })
  })

  it('tracer logger should handle error response codes from Logs API', (done) => {

    const V2LogWriter = proxyquire('../src', {
      '../../log': {
        error: errorLog
      }
    })

    const logger = new V2LogWriter({
      ddsource: 'logging_from_space',
      hostname: 'mac_desktop',
      apiKey: 'API_KEY_PLACEHOLDER',
      interval: 5000
    })
    interceptor = nock('https://http-intake.logs.datadoghq.com:443')
      .post('/api/v2/logs')
      .reply(400, {})

    logger.enqueue({})
    logger.flush((err) => {
      expect(err).to.be.true
      expect(errorLog.getCall(0).args[0]).to.be.equal(
        'failed to send 1 logs, received response code 400'
      )
      done()
    })
  })

  it('tracer logger should handle client side error', (done) => {
    const V2LogWriter = proxyquire('../src', {
      '../../log': {
        error: errorLog
      }
    })

    const logger = new V2LogWriter({
      ddsource: 'logging_from_space',
      hostname: 'mac_desktop',
      apiKey: 'API_KEY_PLACEHOLDER',
      interval: 5000
    })

    interceptor = nock('https://http-intake.logs.datadoghq.com:443')
      .post('/api/v2/logs')
      .replyWithError('missing API key')

    logger.enqueue({})
    logger.flush((err) => {
      expect(err).to.be.an.instanceOf(Error)
      expect(errorLog.getCall(0).args[0]).to.be.equal(
        'failed to send 1 log(s), with error missing API key'
      )
      done()
    })
  })
})
