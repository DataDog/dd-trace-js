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
    errorLog = sinon.spy(tracerLogger, 'error')

    const { ExternalLogger } = proxyquire('../src', {
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

  it('should empty the log queue when calling flush', (done) => {
    interceptor = nock('https://http-intake.logs.datadoghq.com:443')
      .post('/api/v2/logs')
      .reply(202, {})

    externalLogger.enqueue({})
    expect(externalLogger.queue.length).to.equal(1)

    externalLogger.flush((err) => {
      expect(externalLogger.queue.length).to.equal(0)
      done(err)
    })
  })

  it('tracer logger should handle error response codes from Logs API', (done) => {
    interceptor = nock('https://http-intake.logs.datadoghq.com:443')
      .post('/api/v2/logs')
      .reply(400, {})

    externalLogger.enqueue({})
    externalLogger.flush((err) => {
      expect(err).to.be.an.instanceOf(Error)
      expect(errorLog.getCall(0).args[0]).to.be.equal(
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
      expect(err).to.be.an.instanceOf(Error)
      expect(errorLog.getCall(0).args[0]).to.be.equal(
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
    expect(flusher).to.not.have.been.called

    externalLogger.enqueue({})
    expect(flusher).to.have.been.called

    flusher.restore()
    done()
  })
})
