'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

const { publishWithCompletion } = require('../../../datadog-instrumentations/src/helpers/channel')

const logSubmissionCh = channel('ci:log-submission:log')
const logSubmissionFlushCh = channel('ci:log-submission:flush')
const winstonAddTransportCh = channel('ci:log-submission:winston:add-transport')
const winstonConfigureCh = channel('ci:log-submission:winston:configure')
const request = sinon.stub()
const log = {
  error: sinon.stub(),
}
const pluginConfig = {
  enabled: true,
  DD_AGENTLESS_LOG_SUBMISSION_URL: 'http://127.0.0.1:8126',
  DD_API_KEY: 'secret',
  service: 'my service',
  site: 'datadoghq.com',
}
const LogSubmissionPlugin = proxyquire('../../src/log-submission/log-submission-plugin', {
  '../exporters/common/request': request,
  '../log': log,
})

/**
 * @param {string | Record<string, unknown>} message
 * @param {string} [source]
 * @returns {void}
 */
function publishLog (message, source = 'bunyan') {
  logSubmissionCh.publish({ source, message })
}

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
    plugin.configure(pluginConfig)
    beforeExitHandler = [...beforeExitHandlers].find(handler => !previousBeforeExitHandlers.has(handler))
  })

  afterEach(() => {
    plugin.configure(false)
    clock.restore()
  })

  it('batches Bunyan logs and submits them after one second', () => {
    publishLog('{"msg":"hello"}\n')

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

  it('batches Winston-formatted logs through the shared sender', () => {
    const format = {}
    const createJsonFormat = sinon.stub().returns(format)
    class StreamTransport {
      constructor (options) {
        this.options = options
      }
    }
    const logger = { add: sinon.stub() }

    winstonAddTransportCh.publish(logger)
    sinon.assert.notCalled(logger.add)

    winstonConfigureCh.publish({ createJsonFormat, StreamTransport })

    sinon.assert.calledOnce(logger.add)
    const transport = logger.add.firstCall.args[0]
    assert.ok(transport instanceof StreamTransport)
    assert.strictEqual(transport.options.format, format)

    transport.options.stream.write('{"level":"info","message":"hello"}')
    clock.tick(1000)

    sinon.assert.calledOnce(request)
    const [data, options] = request.firstCall.args
    assert.deepStrictEqual(JSON.parse(data), [{ level: 'info', message: 'hello' }])
    assert.strictEqual(options.path, '/api/v2/logs?ddsource=winston&service=my+service')
  })

  it('flushes pending Bunyan logs before exit', () => {
    publishLog('{"msg":"hello"}')
    sinon.assert.notCalled(request)

    beforeExitHandler()

    sinon.assert.calledOnce(request)
  })

  it('completes a log submission flush immediately when no logs are pending', () => {
    const onDone = sinon.spy()

    publishWithCompletion(logSubmissionFlushCh, {}, onDone)

    sinon.assert.calledOnce(onDone)
    sinon.assert.notCalled(request)
  })

  it('flushes the batch and waits for the intake request to finish', () => {
    let onRequestDone
    request.callsFake((data, options, callback) => {
      onRequestDone = callback
    })
    publishLog('{"msg":"hello"}')
    const onDone = sinon.spy()

    publishWithCompletion(logSubmissionFlushCh, {}, onDone)

    sinon.assert.calledOnce(request)
    sinon.assert.notCalled(onDone)
    onRequestDone()
    sinon.assert.calledOnce(onDone)
  })

  it('does not wait for a request started after the flush snapshot', () => {
    const requestCallbacks = []
    request.callsFake((data, options, callback) => requestCallbacks.push(callback))
    publishLog('{"msg":"first"}')
    const onDone = sinon.spy()
    publishWithCompletion(logSubmissionFlushCh, {}, onDone)

    publishLog('{"msg":"second"}')
    clock.tick(1000)
    assert.strictEqual(requestCallbacks.length, 2)
    requestCallbacks[0]()

    sinon.assert.calledOnce(onDone)
    requestCallbacks[1]()
  })

  it('releases a flush when the intake request fails', () => {
    let onRequestDone
    request.callsFake((data, options, callback) => {
      onRequestDone = callback
    })
    publishLog('{"msg":"hello"}')
    const onDone = sinon.spy()
    const error = new Error('boom')
    publishWithCompletion(logSubmissionFlushCh, {}, onDone)

    onRequestDone(error)

    sinon.assert.calledOnce(onDone)
    sinon.assert.calledWith(log.error, 'Error submitting %s logs', 'bunyan', error)
  })

  it('aborts pending requests and releases the final flush at the deadline', () => {
    request.callsFake(() => {})
    publishLog('{"msg":"hello"}')
    const onDone = sinon.spy()

    publishWithCompletion(logSubmissionFlushCh, {}, onDone)

    const { signal } = request.firstCall.args[1]
    clock.tick(60_000 - 1)
    sinon.assert.notCalled(onDone)
    assert.strictEqual(signal.aborted, false)
    clock.tick(1)
    sinon.assert.calledOnce(onDone)
    assert.strictEqual(signal.aborted, true)
    assert.strictEqual(signal.reason.code, 'ERR_DD_LOG_SUBMISSION_FLUSH_TIMEOUT')
  })

  it('waits for every intake request in the flush snapshot', () => {
    const requestCallbacks = []
    request.callsFake((data, options, callback) => requestCallbacks.push(callback))
    publishLog('{"msg":"bunyan"}')
    publishLog('{"msg":"pino"}', 'pino')
    const onDone = sinon.spy()

    publishWithCompletion(logSubmissionFlushCh, {}, onDone)

    assert.strictEqual(requestCallbacks.length, 2)
    requestCallbacks[0]()
    sinon.assert.notCalled(onDone)
    requestCallbacks[1]()
    sinon.assert.calledOnce(onDone)
  })

  it('releases a flush when request throws synchronously', () => {
    const error = new Error('boom')
    request.throws(error)
    publishLog('{"msg":"hello"}')
    const onDone = sinon.spy()

    publishWithCompletion(logSubmissionFlushCh, {}, onDone)

    sinon.assert.calledOnce(onDone)
    sinon.assert.calledWith(log.error, 'Error submitting %s logs', 'bunyan', error)
  })

  it('uses the default logs intake when no override is configured', () => {
    plugin.configure({
      ...pluginConfig,
      DD_AGENTLESS_LOG_SUBMISSION_URL: undefined,
    })
    publishLog('{"msg":"hello"}')
    clock.tick(1000)

    assert.strictEqual(request.firstCall.args[1].url.href, 'https://http-intake.logs.datadoghq.com/')
  })

  it('accepts uppercase letters in the default logs intake site', () => {
    plugin.configure({
      ...pluginConfig,
      DD_AGENTLESS_LOG_SUBMISSION_URL: undefined,
      site: 'DATADOGHQ.COM',
    })
    publishLog('{"msg":"hello"}')
    clock.tick(1000)

    assert.strictEqual(request.firstCall.args[1].url.href, 'https://http-intake.logs.datadoghq.com/')
  })

  it('does not submit to a URL constructed from an invalid site', () => {
    plugin.configure({
      ...pluginConfig,
      DD_AGENTLESS_LOG_SUBMISSION_URL: undefined,
      site: 'datadoghq.com@other.example',
    })
    publishLog('{"msg":"hello"}')
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
      ...pluginConfig,
      DD_AGENTLESS_LOG_SUBMISSION_URL: 'file:///tmp/logs',
    })
    publishLog('{"msg":"hello"}')
    clock.tick(1000)

    sinon.assert.notCalled(request)
    sinon.assert.calledWith(log.error, 'Unsupported automatic log submission URL protocol: %s', 'file:')
  })

  it('does not submit when the configured URL is invalid', () => {
    plugin.configure({
      ...pluginConfig,
      DD_AGENTLESS_LOG_SUBMISSION_URL: 'not a URL',
    })
    publishLog('{"msg":"hello"}')
    clock.tick(1000)

    sinon.assert.notCalled(request)
    sinon.assert.calledWith(log.error, 'Could not parse DD_AGENTLESS_LOG_SUBMISSION_URL')
  })

  it('flushes at 1000 logs and leaves the next log for the next batch', () => {
    for (let index = 0; index < 999; index++) {
      publishLog('{"msg":"hello"}')
    }
    sinon.assert.notCalled(request)

    publishLog('{"msg":"hello"}')
    sinon.assert.calledOnce(request)
    assert.strictEqual(JSON.parse(request.firstCall.args[0]).length, 1000)

    publishLog('{"msg":"next"}')
    sinon.assert.calledOnce(request)
    clock.tick(1000)
    sinon.assert.calledTwice(request)
    assert.deepStrictEqual(JSON.parse(request.secondCall.args[0]), [{ msg: 'next' }])
  })

  it('does not mix different log sources in the same batch', () => {
    publishLog('{"msg":"bunyan"}')
    publishLog('{"msg":"pino"}', 'pino')

    sinon.assert.calledOnce(request)
    assert.deepStrictEqual(JSON.parse(request.firstCall.args[0]), [{ msg: 'bunyan' }])
    assert.strictEqual(request.firstCall.args[1].path, '/api/v2/logs?ddsource=bunyan&service=my+service')

    clock.tick(1000)
    sinon.assert.calledTwice(request)
    assert.deepStrictEqual(JSON.parse(request.secondCall.args[0]), [{ msg: 'pino' }])
    assert.strictEqual(request.secondCall.args[1].path, '/api/v2/logs?ddsource=pino&service=my+service')
  })

  it('does not retain a log after a source-change pre-flush fails synchronously', () => {
    request.throws(new Error('boom'))
    publishLog('{"msg":"bunyan"}')

    publishLog('{"msg":"pino"}', 'pino')

    sinon.assert.calledOnce(request)
    plugin.configure(pluginConfig)
    beforeExitHandler()
    sinon.assert.calledOnce(request)
  })

  it('accepts the byte limit and rejects the first byte over it', () => {
    const maximumBatchBytes = 5 * 1024 * 1024
    const acceptedMessage = `"${'a'.repeat(maximumBatchBytes - 4)}"`
    publishLog(acceptedMessage)

    sinon.assert.calledOnce(request)
    assert.strictEqual(request.firstCall.args[0].length, maximumBatchBytes)

    const rejectedMessage = `"${'a'.repeat(maximumBatchBytes - 3)}"`
    publishLog(rejectedMessage)

    sinon.assert.calledOnce(request)
    sinon.assert.calledWith(
      log.error,
      'Could not submit %s log because it exceeds the %d byte payload limit',
      'bunyan',
      maximumBatchBytes
    )
  })

  it('flushes the current batch before adding a log that would exceed the byte limit', () => {
    const maximumBatchBytes = 5 * 1024 * 1024
    const firstMessage = `"${'a'.repeat(maximumBatchBytes - 5)}"`
    publishLog(firstMessage)
    sinon.assert.notCalled(request)

    publishLog('0')
    sinon.assert.calledOnce(request)
    assert.strictEqual(request.firstCall.args[0].length, maximumBatchBytes - 1)

    clock.tick(1000)
    sinon.assert.calledTwice(request)
    assert.deepStrictEqual(JSON.parse(request.secondCall.args[0]), [0])
  })

  it('does not retain a log after a byte-limit pre-flush fails synchronously', () => {
    const maximumBatchBytes = 5 * 1024 * 1024
    const firstMessage = `"${'a'.repeat(maximumBatchBytes - 5)}"`
    request.throws(new Error('boom'))
    publishLog(firstMessage)

    publishLog('0')

    sinon.assert.calledOnce(request)
    plugin.configure(pluginConfig)
    beforeExitHandler()
    sinon.assert.calledOnce(request)
  })

  it('does not throw when a raw Bunyan record cannot be serialized', () => {
    const message = {}
    message.self = message

    publishLog(message)

    sinon.assert.notCalled(request)
    sinon.assert.calledWith(
      log.error,
      'Could not serialize %s log for automatic submission',
      'bunyan',
      sinon.match.instanceOf(TypeError)
    )
    assert.strictEqual(plugin._enabled, true)
  })

  it('does not throw or remain pending when the request fails', () => {
    const failure = new Error('boom')
    request.callsFake((data, options, callback) => callback(failure))

    publishLog('{"msg":"hello"}')
    clock.tick(1000)

    sinon.assert.calledWith(log.error, 'Error submitting %s logs', 'bunyan', failure)
    assert.strictEqual(plugin._enabled, true)
  })

  it('disables submission before reporting synchronous request failures', () => {
    const failure = new Error('boom')
    request.throws(failure)
    log.error.callsFake(() => publishLog('{"msg":"sender failure"}'))

    publishLog('{"msg":"hello"}')
    clock.tick(1000)

    sinon.assert.calledOnce(request)
    sinon.assert.calledWith(log.error, 'Error submitting %s logs', 'bunyan', failure)
    clock.tick(1000)
    sinon.assert.calledOnce(request)
    assert.strictEqual(plugin._enabled, true)
  })
})
