'use strict'

require('../../../../dd-trace/test/setup/tap')
const { expect } = require('chai')
const nock = require('nock')
const tracerLogger = require('../../log')
const proxyquire = require('proxyquire')

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
  })

  it('should get a 202 response when posting a log', (done) => {
    const currentTime = Date.now()
    nock('https://http-intake.logs.datadoghq.com:443')
      .post('/api/v2/logs')
      .reply((uri, request, cb) => {
        cb(null, [202, '{}', { 'Content-Type': 'application/json' }])
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
          return done(e)
        }
        done()
        nock.removeInterceptor()
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
    externalLogger.flush()
  })

  it('calling flush should empty the buffer', (done) => {
    nock('https://http-intake.logs.datadoghq.com:443')
      .post('/api/v2/logs')
      .reply(202, {})

    externalLogger.enqueue({})
    expect(externalLogger.buffer.length).to.equal(1)
    externalLogger.flush()
    expect(externalLogger.buffer.length).to.equal(0)

    done()
  })

  describe('Tracer Logger should be called to log errors', function () {
    it.skip('ltracer logger should handle error response codes from Logs API', (done) => {
      const errorLog = sinon.spy(tracerLogger, 'error')

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
      nock('https://http-intake.logs.datadoghq.com:443')
        .post('/api/v2/logs')
        .reply(400, {})

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
      const log = logger.log({
        message: 'oh no, something is up',
        custom: 'field',
        attribute: 'funky',
        service: 'outer_space',
        level: 'info'
      }, span, tags)
      logger.enqueue(log)
      logger.flush()

      setTimeout(() => {
        expect(errorLog.getCall(0).args[0]).to.be.equal('failed to send 1 logs, received response code 400')
      }, 5000)

      done()
    })
  })
  describe('Tracer Logger should be called to log errors', function () {
    it('ltracer logger should handle client side error', (done) => {
      const errorLog = sinon.spy(tracerLogger, 'error')

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
      nock('https://http-intake.logs.datadoghq.com:443')
        .post('/api/v2/logs')
        .replyWithError('missing API key')

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
      const log = logger.log({
        message: 'oh no, something is up',
        custom: 'field',
        attribute: 'funky',
        service: 'outer_space',
        level: 'info'
      }, span, tags)
      logger.enqueue(log)
      logger.flush()

      setTimeout(() => {
        expect(errorLog.getCall(0).args[0]).to.be.equal('failed to send 1 log(s), with error missing API key')
      }, 10000)
      done()
    })
  })
})
