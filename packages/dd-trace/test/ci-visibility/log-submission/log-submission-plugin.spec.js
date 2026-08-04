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
const playwrightTestFinishCh = channel('ci:playwright:test:finish')
const playwrightWorkerFinishCh = channel('ci:playwright:worker:finish')
const batchFlushInterval = 1000
const maxBatchBytes = 5 * 1024 * 1024
const maxBatchLogs = 1000

describe('LogSubmissionPlugin', () => {
  let beforeExitHandlers
  let clock
  let errorLog
  let initialBeforeExitHandlers
  let plugin
  let request

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    errorLog = sinon.spy()
    request = sinon.stub().callsFake((data, options, callback) => callback(null))
    beforeExitHandlers = globalThis[Symbol.for('dd-trace')].beforeExitHandlers
    initialBeforeExitHandlers = new Set(beforeExitHandlers)

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
    clock.restore()
  })

  it('submits a finalized pino JSON line', () => {
    logSubmissionCh.publish({
      source: 'pino',
      message: '{"level":30,"msg":"hello","dd":{"span_id":"1"}}\n',
    })

    sinon.assert.notCalled(request)
    clock.tick(batchFlushInterval - 1)
    sinon.assert.notCalled(request)
    clock.tick(1)

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

  it('batches multiple logs from the same source', () => {
    logSubmissionCh.publish({ source: 'pino', message: '{"msg":"first"}\n' })
    logSubmissionCh.publish({ source: 'pino', message: '{"msg":"second"}\n' })

    sinon.assert.notCalled(request)
    clock.tick(batchFlushInterval)

    sinon.assert.calledOnce(request)
    assert.deepStrictEqual(JSON.parse(request.firstCall.args[0]), [
      { msg: 'first' },
      { msg: 'second' },
    ])
  })

  it('keeps batches separate by log source', () => {
    logSubmissionCh.publish({ source: 'pino', message: '{"msg":"pino"}\n' })
    logSubmissionCh.publish({ source: 'bunyan', message: { msg: 'bunyan' } })

    clock.tick(batchFlushInterval)

    sinon.assert.calledTwice(request)
    assert.deepStrictEqual(JSON.parse(request.firstCall.args[0]), [{ msg: 'pino' }])
    assert.strictEqual(request.firstCall.args[1].path, '/api/v2/logs?ddsource=pino&service=my-service')
    assert.deepStrictEqual(JSON.parse(request.secondCall.args[0]), [{ msg: 'bunyan' }])
    assert.strictEqual(request.secondCall.args[1].path, '/api/v2/logs?ddsource=bunyan&service=my-service')
  })

  it('flushes at 1000 logs and starts a new batch with the next log', () => {
    for (let index = 0; index < maxBatchLogs - 1; index++) {
      logSubmissionCh.publish({ source: 'pino', message: `{"index":${index}}` })
    }
    sinon.assert.notCalled(request)

    logSubmissionCh.publish({ source: 'pino', message: `{"index":${maxBatchLogs - 1}}` })

    sinon.assert.calledOnce(request)
    const firstBatch = JSON.parse(request.firstCall.args[0])
    assert.strictEqual(firstBatch.length, maxBatchLogs)
    assert.strictEqual(firstBatch.at(-1).index, maxBatchLogs - 1)

    logSubmissionCh.publish({ source: 'pino', message: `{"index":${maxBatchLogs}}` })
    sinon.assert.calledOnce(request)

    clock.tick(batchFlushInterval)

    sinon.assert.calledTwice(request)
    assert.deepStrictEqual(JSON.parse(request.secondCall.args[0]), [{ index: maxBatchLogs }])
  })

  it('accepts a 5 MiB batch and drops the first byte over the limit', () => {
    const messagePrefix = '{"msg":"'
    const messageSuffix = '"}'
    const messageAtLimit = messagePrefix + 'x'.repeat(maxBatchBytes - 12) + messageSuffix

    logSubmissionCh.publish({ source: 'pino', message: messageAtLimit })

    sinon.assert.calledOnce(request)
    assert.strictEqual(Buffer.byteLength(request.firstCall.args[0]), maxBatchBytes)

    request.resetHistory()
    const messageOverLimit = messagePrefix + 'x'.repeat(maxBatchBytes - 11) + messageSuffix

    logSubmissionCh.publish({ source: 'pino', message: messageOverLimit })

    sinon.assert.notCalled(request)
    sinon.assert.calledWithExactly(
      errorLog,
      'Could not submit %s log because it exceeds the %d byte payload limit',
      'pino',
      maxBatchBytes
    )
  })

  it('flushes the current batch before the next log exceeds the byte limit', () => {
    const message = `{"msg":"${'x'.repeat(Math.floor(maxBatchBytes / 2))}"}`

    logSubmissionCh.publish({ source: 'pino', message })
    sinon.assert.notCalled(request)

    logSubmissionCh.publish({ source: 'pino', message })

    sinon.assert.calledOnce(request)
    assert.ok(Buffer.byteLength(request.firstCall.args[0]) <= maxBatchBytes)

    clock.tick(batchFlushInterval)

    sinon.assert.calledTwice(request)
    assert.ok(Buffer.byteLength(request.secondCall.args[0]) <= maxBatchBytes)
  })

  it('flushes pending batches before exit and unregisters when disabled', () => {
    const addedBeforeExitHandlers = [...beforeExitHandlers].filter(handler => !initialBeforeExitHandlers.has(handler))
    assert.strictEqual(addedBeforeExitHandlers.length, 1)
    const [beforeExitHandler] = addedBeforeExitHandlers

    logSubmissionCh.publish({ source: 'bunyan', message: { msg: 'hello' } })
    beforeExitHandler()

    sinon.assert.calledOnce(request)
    assert.deepStrictEqual(JSON.parse(request.firstCall.args[0]), [{ msg: 'hello' }])

    plugin.configure(false)
    assert.strictEqual(beforeExitHandlers.has(beforeExitHandler), false)
  })

  it('batches across Playwright tests and waits for submission when the worker finishes', async () => {
    let hasCompleted = false
    request.callsFake((data, options, callback) => {
      Promise.resolve().then(() => callback(null))
    })
    logSubmissionCh.publish({ source: 'pino', message: '{"msg":"first"}\n' })

    playwrightTestFinishCh.publish()

    sinon.assert.notCalled(request)
    logSubmissionCh.publish({ source: 'pino', message: '{"msg":"last"}\n' })

    playwrightWorkerFinishCh.publish({
      registerCompletion: () => () => {
        hasCompleted = true
      },
    })

    sinon.assert.calledOnce(request)
    assert.deepStrictEqual(JSON.parse(request.firstCall.args[0]), [
      { msg: 'first' },
      { msg: 'last' },
    ])
    assert.strictEqual(hasCompleted, false)

    await Promise.resolve()
    assert.strictEqual(hasCompleted, true)
  })

  it('waits for batches already in flight when a Playwright worker finishes', () => {
    const finishRequests = []
    let hasCompleted = false
    request.callsFake((data, options, callback) => {
      finishRequests.push(callback)
    })

    logSubmissionCh.publish({ source: 'pino', message: '{"msg":"first"}\n' })
    clock.tick(batchFlushInterval)
    logSubmissionCh.publish({ source: 'pino', message: '{"msg":"last"}\n' })

    playwrightWorkerFinishCh.publish({
      registerCompletion: () => () => {
        hasCompleted = true
      },
    })

    sinon.assert.calledTwice(request)
    assert.strictEqual(hasCompleted, false)

    finishRequests[0](null)
    assert.strictEqual(hasCompleted, false)

    finishRequests[1](null)
    assert.strictEqual(hasCompleted, true)
  })

  it('completes a Playwright worker when log submission fails', async () => {
    const error = new Error('boom')
    let hasCompleted = false
    request.callsFake((data, options, callback) => {
      Promise.resolve().then(() => callback(error))
    })
    logSubmissionCh.publish({ source: 'bunyan', message: { msg: 'hello' } })

    playwrightWorkerFinishCh.publish({
      registerCompletion: () => () => {
        hasCompleted = true
      },
    })

    assert.strictEqual(hasCompleted, false)
    await Promise.resolve()

    assert.strictEqual(hasCompleted, true)
    sinon.assert.calledWithExactly(errorLog, 'Error submitting %s logs', 'bunyan', error)
  })

  it('completes a Playwright worker when starting log submission throws', () => {
    const error = new Error('boom')
    let hasCompleted = false
    request.throws(error)
    logSubmissionCh.publish({ source: 'pino', message: '{"msg":"hello"}\n' })

    playwrightWorkerFinishCh.publish({
      registerCompletion: () => () => {
        hasCompleted = true
      },
    })

    assert.strictEqual(hasCompleted, true)
    sinon.assert.calledWithExactly(errorLog, 'Error submitting %s logs', 'pino', error)
  })

  it('encodes service names in submitted log paths', () => {
    plugin.configure({
      enabled: true,
      DD_API_KEY: 'api-key',
      service: 'my service&prod',
      site: 'datadoghq.com',
    })

    logSubmissionCh.publish({ source: 'pino', message: '{"msg":"hello"}\n' })
    clock.tick(batchFlushInterval)

    assert.strictEqual(request.firstCall.args[1].path, '/api/v2/logs?ddsource=pino&service=my+service%26prod')
  })

  it('encodes malformed Unicode in service names', () => {
    plugin.configure({
      enabled: true,
      DD_API_KEY: 'api-key',
      service: 'my\uD800service',
      site: 'datadoghq.com',
    })

    logSubmissionCh.publish({ source: 'pino', message: '{"msg":"hello"}\n' })
    clock.tick(batchFlushInterval)

    assert.strictEqual(request.firstCall.args[1].path, '/api/v2/logs?ddsource=pino&service=my%EF%BF%BDservice')
  })

  it('flushes pending logs before applying new configuration', () => {
    logSubmissionCh.publish({ source: 'pino', message: '{"msg":"old"}\n' })

    plugin.configure({
      enabled: true,
      DD_API_KEY: 'new-api-key',
      service: 'new-service',
      site: 'datadoghq.eu',
    })

    sinon.assert.calledOnce(request)
    assert.strictEqual(request.firstCall.args[1].path, '/api/v2/logs?ddsource=pino&service=my-service')
    assert.strictEqual(request.firstCall.args[1].headers['DD-API-KEY'], 'api-key')

    logSubmissionCh.publish({ source: 'pino', message: '{"msg":"new"}\n' })
    clock.tick(batchFlushInterval)

    sinon.assert.calledTwice(request)
    assert.strictEqual(request.secondCall.args[1].path, '/api/v2/logs?ddsource=pino&service=new-service')
    assert.strictEqual(request.secondCall.args[1].headers['DD-API-KEY'], 'new-api-key')
  })

  it('safely serializes a circular bunyan record', () => {
    const record = { level: 30, msg: 'hello' }
    Object.assign(record, { circular: record })

    logSubmissionCh.publish({ source: 'bunyan', message: record })
    clock.tick(batchFlushInterval)

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
    clock.tick(batchFlushInterval)

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
    clock.tick(batchFlushInterval)

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
    clock.tick(batchFlushInterval)

    sinon.assert.calledWithExactly(errorLog, 'Could not parse DD_AGENTLESS_LOG_SUBMISSION_URL')
    assert.strictEqual(request.firstCall.args[1].url.href, 'https://http-intake.logs.datadoghq.eu/')
  })

  it('falls back to the site intake when the configured URL protocol is unsupported', () => {
    plugin.configure({
      enabled: true,
      DD_AGENTLESS_LOG_SUBMISSION_URL: 'ftp://localhost:8126',
      DD_API_KEY: 'api-key',
      service: 'my-service',
      site: 'datadoghq.eu',
    })

    logSubmissionCh.publish({ source: 'pino', message: '{"msg":"hello"}\n' })
    clock.tick(batchFlushInterval)

    sinon.assert.calledWithExactly(errorLog, 'Unsupported automatic log submission URL protocol: %s', 'ftp:')
    assert.strictEqual(request.firstCall.args[1].url.href, 'https://http-intake.logs.datadoghq.eu/')
  })

  it('uses a valid configured URL when the site is invalid', () => {
    plugin.configure({
      enabled: true,
      DD_AGENTLESS_LOG_SUBMISSION_URL: 'http://localhost:8126',
      DD_API_KEY: 'api-key',
      service: 'my-service',
      site: 'invalid site',
    })

    logSubmissionCh.publish({ source: 'pino', message: '{"msg":"hello"}\n' })
    clock.tick(batchFlushInterval)

    assert.strictEqual(request.firstCall.args[1].url.href, 'http://localhost:8126/')
  })

  it('stays disabled when no valid intake URL can be resolved', () => {
    plugin.configure(false)
    plugin.configure({
      enabled: true,
      DD_API_KEY: 'api-key',
      service: 'my-service',
      site: 'invalid site',
    })

    logSubmissionCh.publish({ source: 'pino', message: '{"msg":"hello"}\n' })
    clock.tick(batchFlushInterval)

    sinon.assert.notCalled(request)
    sinon.assert.calledWithExactly(errorLog, 'Could not parse automatic log submission site: %s', 'invalid site')
  })

  it('logs request errors', () => {
    const error = new Error('boom')
    request.callsFake((data, options, callback) => callback(error))

    logSubmissionCh.publish({ source: 'pino', message: '{"msg":"hello"}\n' })
    clock.tick(batchFlushInterval)

    sinon.assert.calledWithExactly(errorLog, 'Error submitting %s logs', 'pino', error)
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

  it('encodes service names in winston transport paths', () => {
    class HttpTransport {
      constructor (options) {
        this.options = options
      }
    }

    plugin.configure({
      enabled: true,
      DD_API_KEY: 'api-key',
      service: 'my service&prod',
      site: 'datadoghq.com',
    })

    const logger = { add: sinon.spy() }
    configureCh.publish(HttpTransport)
    addTransportCh.publish(logger)

    const [{ options }] = logger.add.firstCall.args
    assert.strictEqual(options.path, '/api/v2/logs?ddsource=winston&service=my+service%26prod')
  })
})
