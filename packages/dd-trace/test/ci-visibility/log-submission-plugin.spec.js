'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

const logSubmissionCh = channel('ci:log-submission:bunyan:log')
const request = sinon.stub()
const log = {
  error: sinon.stub(),
}
const LogSubmissionPlugin = proxyquire('../../src/ci-visibility/log-submission/log-submission-plugin', {
  '../../exporters/common/request': request,
  '../../log': log,
})

describe('LogSubmissionPlugin', () => {
  let beforeExitHandler
  let clock
  let plugin

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    request.reset()
    log.error.reset()

    const beforeExitHandlers = globalThis[Symbol.for('dd-trace')].beforeExitHandlers
    const previousBeforeExitHandlers = new Set(beforeExitHandlers)
    plugin = new LogSubmissionPlugin({}, {})
    plugin.configure({
      enabled: true,
      DD_AGENTLESS_LOG_SUBMISSION_URL: 'http://127.0.0.1:8126',
      DD_API_KEY: 'secret',
      service: 'my service',
      site: 'datadoghq.com',
    })
    beforeExitHandler = [...beforeExitHandlers].find(handler => !previousBeforeExitHandlers.has(handler))
  })

  afterEach(() => {
    plugin.configure(false)
    clock.restore()
  })

  it('batches Bunyan logs and submits them after one second', () => {
    logSubmissionCh.publish({ message: '{"msg":"hello"}\n' })

    sinon.assert.notCalled(request)
    clock.tick(999)
    sinon.assert.notCalled(request)
    clock.tick(1)

    sinon.assert.calledOnce(request)
    const [data, options] = request.firstCall.args
    assert.deepStrictEqual(JSON.parse(data), [{ msg: 'hello' }])
    assert.strictEqual(options.method, 'POST')
    assert.strictEqual(options.path, '/api/v2/logs?ddsource=bunyan&service=my+service')
    assert.strictEqual(options.url.href, 'http://127.0.0.1:8126/')
    assert.deepStrictEqual(options.headers, {
      'DD-API-KEY': 'secret',
      'Content-Type': 'application/json',
    })
  })

  it('flushes pending Bunyan logs before exit', () => {
    logSubmissionCh.publish({ message: '{"msg":"hello"}' })
    sinon.assert.notCalled(request)

    beforeExitHandler()

    sinon.assert.calledOnce(request)
  })

  it('uses the default logs intake when no override is configured', () => {
    plugin.configure({
      enabled: true,
      DD_API_KEY: 'secret',
      service: 'my service',
      site: 'datadoghq.com',
    })
    logSubmissionCh.publish({ message: '{"msg":"hello"}' })
    clock.tick(1000)

    assert.strictEqual(request.firstCall.args[1].url.href, 'https://http-intake.logs.datadoghq.com/')
  })

  it('does not submit to a URL constructed from an invalid site', () => {
    plugin.configure({
      enabled: true,
      DD_API_KEY: 'secret',
      service: 'my service',
      site: 'datadoghq.com@other.example',
    })
    logSubmissionCh.publish({ message: '{"msg":"hello"}' })
    clock.tick(1000)

    sinon.assert.notCalled(request)
    sinon.assert.calledWith(
      log.error,
      'Could not parse automatic log submission site: %s',
      'datadoghq.com@other.example'
    )
  })

  it('does not submit when the configured URL uses an unsupported protocol', () => {
    plugin.configure({
      enabled: true,
      DD_AGENTLESS_LOG_SUBMISSION_URL: 'file:///tmp/logs',
      DD_API_KEY: 'secret',
      service: 'my service',
      site: 'datadoghq.com',
    })
    logSubmissionCh.publish({ message: '{"msg":"hello"}' })
    clock.tick(1000)

    sinon.assert.notCalled(request)
    sinon.assert.calledWith(log.error, 'Unsupported automatic log submission URL protocol: %s', 'file:')
  })

  it('does not submit when the configured URL is invalid', () => {
    plugin.configure({
      enabled: true,
      DD_AGENTLESS_LOG_SUBMISSION_URL: 'not a URL',
      DD_API_KEY: 'secret',
      service: 'my service',
      site: 'datadoghq.com',
    })
    logSubmissionCh.publish({ message: '{"msg":"hello"}' })
    clock.tick(1000)

    sinon.assert.notCalled(request)
    sinon.assert.calledWith(log.error, 'Could not parse DD_AGENTLESS_LOG_SUBMISSION_URL')
  })

  it('flushes at 1000 logs and leaves the next log for the next batch', () => {
    for (let index = 0; index < 999; index++) {
      logSubmissionCh.publish({ message: '{"msg":"hello"}' })
    }
    sinon.assert.notCalled(request)

    logSubmissionCh.publish({ message: '{"msg":"hello"}' })
    sinon.assert.calledOnce(request)
    assert.strictEqual(JSON.parse(request.firstCall.args[0]).length, 1000)

    logSubmissionCh.publish({ message: '{"msg":"next"}' })
    sinon.assert.calledOnce(request)
    clock.tick(1000)
    sinon.assert.calledTwice(request)
    assert.deepStrictEqual(JSON.parse(request.secondCall.args[0]), [{ msg: 'next' }])
  })

  it('accepts the byte limit and rejects the first byte over it', () => {
    const maximumBatchBytes = 5 * 1024 * 1024
    const acceptedMessage = `"${'a'.repeat(maximumBatchBytes - 4)}"`
    logSubmissionCh.publish({ message: acceptedMessage })

    sinon.assert.calledOnce(request)
    assert.strictEqual(request.firstCall.args[0].length, maximumBatchBytes)

    const rejectedMessage = `"${'a'.repeat(maximumBatchBytes - 3)}"`
    logSubmissionCh.publish({ message: rejectedMessage })

    sinon.assert.calledOnce(request)
    sinon.assert.calledWith(
      log.error,
      'Could not submit Bunyan log because it exceeds the %d byte payload limit',
      maximumBatchBytes
    )
  })

  it('flushes the current batch before adding a log that would exceed the byte limit', () => {
    const maximumBatchBytes = 5 * 1024 * 1024
    const firstMessage = `"${'a'.repeat(maximumBatchBytes - 5)}"`
    logSubmissionCh.publish({ message: firstMessage })
    sinon.assert.notCalled(request)

    logSubmissionCh.publish({ message: '0' })
    sinon.assert.calledOnce(request)
    assert.strictEqual(request.firstCall.args[0].length, maximumBatchBytes - 1)

    clock.tick(1000)
    sinon.assert.calledTwice(request)
    assert.deepStrictEqual(JSON.parse(request.secondCall.args[0]), [0])
  })

  it('does not throw when a raw Bunyan record cannot be serialized', () => {
    const message = {}
    message.self = message

    logSubmissionCh.publish({ message })

    sinon.assert.notCalled(request)
    sinon.assert.calledWith(
      log.error,
      'Could not serialize Bunyan log for automatic submission',
      sinon.match.instanceOf(TypeError)
    )
    assert.strictEqual(plugin._enabled, true)
  })

  it('does not throw or remain pending when the request fails', () => {
    const failure = new Error('boom')
    request.callsFake((data, options, callback) => callback(failure))

    logSubmissionCh.publish({ message: '{"msg":"hello"}' })
    clock.tick(1000)

    sinon.assert.calledWith(log.error, 'Error submitting Bunyan logs', failure)
    assert.strictEqual(plugin._enabled, true)
  })

  it('does not throw when starting the request fails synchronously', () => {
    const failure = new Error('boom')
    request.throws(failure)

    logSubmissionCh.publish({ message: '{"msg":"hello"}' })
    clock.tick(1000)

    sinon.assert.calledWith(log.error, 'Error submitting Bunyan logs', failure)
    assert.strictEqual(plugin._enabled, true)
  })
})
