'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const { channel } = require('dc-polyfill')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')

const configureCh = channel('ci:log-submission:winston:configure')
const addTransportCh = channel('ci:log-submission:winston:add-transport')
const logSubmissionCh = channel('ci:log-submission:log')

describe('LogSubmissionPlugin', () => {
  let errorLog
  let plugin
  let request

  beforeEach(() => {
    errorLog = sinon.spy()
    request = sinon.stub().callsFake((data, options, callback) => callback(null))

    const LogSubmissionPlugin = proxyquire('../../../src/ci-visibility/log-submission/log-submission-plugin', {
      '../../exporters/common/request': request,
      '../../log': { error: errorLog },
    })

    plugin = new LogSubmissionPlugin({})
    plugin.configure({
      enabled: true,
      DD_API_KEY: 'api-key',
      service: 'my-service',
      site: 'datadoghq.com',
    })
  })

  afterEach(() => {
    plugin.configure(false)
  })

  it('submits a finalized pino JSON line', () => {
    logSubmissionCh.publish({
      source: 'pino',
      message: '{"level":30,"msg":"hello","dd":{"span_id":"1"}}\n',
    })

    sinon.assert.calledOnce(request)
    const [body, options] = request.firstCall.args
    assert.deepStrictEqual(JSON.parse(body), [{
      level: 30,
      msg: 'hello',
      dd: { span_id: '1' },
    }])
    assert.strictEqual(options.path, '/api/v2/logs?ddsource=pino&service=my-service')
    assert.strictEqual(options.method, 'POST')
    assert.strictEqual(options.url.href, 'https://http-intake.logs.datadoghq.com/')
    assert.deepStrictEqual(options.headers, {
      'DD-API-KEY': 'api-key',
      'Content-Type': 'application/json',
    })
  })

  it('safely serializes a circular bunyan record', () => {
    const record = { level: 30, msg: 'hello' }
    Object.assign(record, { circular: record })

    logSubmissionCh.publish({ source: 'bunyan', message: record })

    sinon.assert.calledOnce(request)
    assert.deepStrictEqual(JSON.parse(request.firstCall.args[0]), [{
      level: 30,
      msg: 'hello',
      circular: '[Circular]',
    }])
    assert.strictEqual(request.firstCall.args[1].path, '/api/v2/logs?ddsource=bunyan&service=my-service')
  })

  it('preserves repeated non-circular bunyan objects', () => {
    const shared = { id: 7 }
    const record = {
      level: 30,
      msg: 'hello',
      left: shared,
      right: shared,
    }

    logSubmissionCh.publish({ source: 'bunyan', message: record })

    sinon.assert.calledOnce(request)
    assert.deepStrictEqual(JSON.parse(request.firstCall.args[0]), [{
      level: 30,
      msg: 'hello',
      left: { id: 7 },
      right: { id: 7 },
    }])
  })

  it('uses the configured intake URL', () => {
    plugin.configure({
      enabled: true,
      DD_AGENTLESS_LOG_SUBMISSION_URL: 'http://localhost:8126/custom/path',
      DD_API_KEY: 'api-key',
      service: 'my-service',
      site: 'datadoghq.com',
    })

    logSubmissionCh.publish({ source: 'pino', message: '{"msg":"hello"}\n' })

    assert.strictEqual(request.firstCall.args[1].url.href, 'http://localhost:8126/custom/path')
    assert.strictEqual(request.firstCall.args[1].path, '/api/v2/logs?ddsource=pino&service=my-service')
  })

  it('uses the configured intake host and port for winston', () => {
    class HttpTransport {
      constructor (options) {
        this.options = options
      }
    }

    plugin.configure({
      enabled: true,
      DD_AGENTLESS_LOG_SUBMISSION_URL: 'http://localhost:8126',
      DD_API_KEY: 'api-key',
      service: 'my-service',
      site: 'datadoghq.com',
    })

    const logger = { add: sinon.spy() }
    configureCh.publish(HttpTransport)
    addTransportCh.publish(logger)

    const [{ options }] = logger.add.firstCall.args
    assert.strictEqual(options.host, 'localhost')
    assert.strictEqual(options.port, '8126')
    assert.strictEqual(options.ssl, false)
  })

  it('falls back to the site intake when the configured URL is invalid', () => {
    plugin.configure({
      enabled: true,
      DD_AGENTLESS_LOG_SUBMISSION_URL: 'invalid',
      DD_API_KEY: 'api-key',
      service: 'my-service',
      site: 'datadoghq.eu',
    })

    logSubmissionCh.publish({ source: 'pino', message: '{"msg":"hello"}\n' })

    sinon.assert.calledWithExactly(errorLog, 'Could not parse DD_AGENTLESS_LOG_SUBMISSION_URL')
    assert.strictEqual(request.firstCall.args[1].url.href, 'https://http-intake.logs.datadoghq.eu/')
  })

  it('logs request errors', () => {
    const error = new Error('boom')
    request.callsFake((data, options, callback) => callback(error))

    logSubmissionCh.publish({ source: 'pino', message: '{"msg":"hello"}\n' })

    sinon.assert.calledWithExactly(errorLog, 'Error submitting %s log', 'pino', error)
  })

  it('logs serialization errors without submitting the record', () => {
    const error = new TypeError('Do not know how to serialize a BigInt')

    logSubmissionCh.publish({ source: 'bunyan', message: { value: 1n } })

    sinon.assert.notCalled(request)
    sinon.assert.calledOnce(errorLog)
    assert.strictEqual(errorLog.firstCall.args[0], 'Could not serialize %s log for automatic submission')
    assert.strictEqual(errorLog.firstCall.args[1], 'bunyan')
    assert.strictEqual(errorLog.firstCall.args[2].message, error.message)
  })

  it('preserves winston HTTP transport submission', () => {
    class HttpTransport {
      constructor (options) {
        this.options = options
      }
    }

    const logger = { add: sinon.spy() }
    configureCh.publish(HttpTransport)
    addTransportCh.publish(logger)

    sinon.assert.calledOnce(logger.add)
    const [{ options }] = logger.add.firstCall.args
    assert.deepStrictEqual(options, {
      host: 'http-intake.logs.datadoghq.com',
      path: '/api/v2/logs?ddsource=winston&service=my-service',
      ssl: true,
      headers: {
        'DD-API-KEY': 'api-key',
      },
    })
  })
})
