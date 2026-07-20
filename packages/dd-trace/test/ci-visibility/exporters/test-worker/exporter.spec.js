'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const context = describe
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../../../../dd-trace/test/setup/core')
const TestWorkerCiVisibilityExporter = proxyquire('../../../../src/ci-visibility/exporters/test-worker', {
  '../../../config': () => proxyquire.noPreserveCache()('../../../../src/config', {})(),
})

const {
  JEST_WORKER_TRACE_PAYLOAD_CODE,
  JEST_WORKER_COVERAGE_PAYLOAD_CODE,
  CUCUMBER_WORKER_TRACE_PAYLOAD_CODE,
  MOCHA_WORKER_TRACE_PAYLOAD_CODE,
  PLAYWRIGHT_WORKER_TRACE_PAYLOAD_CODE,
  PLAYWRIGHT_WORKER_SCREENSHOT_REQUEST,
  PLAYWRIGHT_WORKER_SCREENSHOT_RESPONSE,
  VITEST_WORKER_TRACE_PAYLOAD_CODE,
} = require('../../../../src/plugins/util/test')

describe('CI Visibility Test Worker Exporter', () => {
  let send, originalSend

  beforeEach(() => {
    send = sinon.spy()
    originalSend = process.send
    process.send = send
  })

  afterEach(() => {
    process.send = originalSend
  })

  context('when the process is a jest worker', () => {
    beforeEach(() => {
      process.env.JEST_WORKER_ID = '1'
    })
    afterEach(() => {
      delete process.env.JEST_WORKER_ID
    })

    it('can export traces', () => {
      const trace = [{ type: 'test' }]
      const traceSecond = [{ type: 'test', name: 'other' }]
      const jestWorkerExporter = new TestWorkerCiVisibilityExporter()
      jestWorkerExporter.export(trace)
      jestWorkerExporter.export(traceSecond)
      jestWorkerExporter.flush()
      sinon.assert.calledWith(send, [JEST_WORKER_TRACE_PAYLOAD_CODE, JSON.stringify([trace, traceSecond])])
    })

    it('can export coverages', () => {
      const coverage = { sessionId: '1', suiteId: '1', files: ['test.js'] }
      const coverageSecond = { sessionId: '2', suiteId: '2', files: ['test2.js'] }
      const jestWorkerExporter = new TestWorkerCiVisibilityExporter()
      jestWorkerExporter.exportCoverage(coverage)
      jestWorkerExporter.exportCoverage(coverageSecond)
      jestWorkerExporter.flush()
      sinon.assert.calledWith(send,
        [JEST_WORKER_COVERAGE_PAYLOAD_CODE, JSON.stringify([coverage, coverageSecond])]
      )
    })

    it('signals completion after all queued payloads flush', () => {
      const callbacks = []
      send = sinon.stub().callsFake((payload, callback) => {
        callbacks.push(callback)
      })
      process.send = send
      const jestWorkerExporter = new TestWorkerCiVisibilityExporter()
      const onDone = sinon.spy()

      jestWorkerExporter.export([{ type: 'test' }])
      jestWorkerExporter.exportCoverage({ sessionId: '1', suiteId: '1', files: ['test.js'] })
      jestWorkerExporter.exportDiLogs({ testSessionId: '1' }, { message: 'test log' })
      jestWorkerExporter.exportTelemetry({ type: 'ciVisEvent', name: 'test_event' })
      jestWorkerExporter.flush(onDone)

      assert.strictEqual(callbacks.length, 4)
      callbacks[0]()
      sinon.assert.notCalled(onDone)
      callbacks[1]()
      sinon.assert.notCalled(onDone)
      callbacks[2]()
      sinon.assert.notCalled(onDone)
      callbacks[3]()
      sinon.assert.calledOnce(onDone)
    })

    it('signals completion when only coverage is queued', () => {
      const callbacks = []
      send = sinon.stub().callsFake((payload, callback) => {
        callbacks.push(callback)
      })
      process.send = send
      const jestWorkerExporter = new TestWorkerCiVisibilityExporter()
      const onDone = sinon.spy()

      jestWorkerExporter.exportCoverage({ sessionId: '1', suiteId: '1', files: ['test.js'] })
      jestWorkerExporter.flush(onDone)

      assert.strictEqual(callbacks.length, 1)
      callbacks[0]()
      sinon.assert.calledOnce(onDone)
    })

    it('does not break if process.send is undefined', () => {
      delete process.send
      const trace = [{ type: 'test' }]
      const jestWorkerExporter = new TestWorkerCiVisibilityExporter()
      jestWorkerExporter.export(trace)
      jestWorkerExporter.flush()
      sinon.assert.notCalled(send)
    })
  })

  context('when the process is a cucumber worker', () => {
    beforeEach(() => {
      process.env.CUCUMBER_WORKER_ID = '1'
    })
    afterEach(() => {
      delete process.env.CUCUMBER_WORKER_ID
    })

    it('can export traces', () => {
      const trace = [{ type: 'test' }]
      const traceSecond = [{ type: 'test', name: 'other' }]
      const cucumberWorkerExporter = new TestWorkerCiVisibilityExporter()
      cucumberWorkerExporter.export(trace)
      cucumberWorkerExporter.export(traceSecond)
      cucumberWorkerExporter.flush()
      sinon.assert.calledWith(send, [CUCUMBER_WORKER_TRACE_PAYLOAD_CODE, JSON.stringify([trace, traceSecond])])
    })

    it('signals completion after traces flush', () => {
      const callbacks = []
      send = sinon.stub().callsFake((payload, callback) => {
        callbacks.push(callback)
      })
      process.send = send
      const cucumberWorkerExporter = new TestWorkerCiVisibilityExporter()
      const onDone = sinon.spy()

      cucumberWorkerExporter.export([{ type: 'test' }])
      cucumberWorkerExporter.flush(onDone)

      assert.strictEqual(callbacks.length, 1)
      callbacks[0]()
      sinon.assert.calledOnce(onDone)
    })

    it('does not break if process.send is undefined', () => {
      delete process.send
      const trace = [{ type: 'test' }]
      const cucumberWorkerExporter = new TestWorkerCiVisibilityExporter()
      cucumberWorkerExporter.export(trace)
      cucumberWorkerExporter.flush()
      sinon.assert.notCalled(send)
    })
  })

  context('when the process is a mocha worker', () => {
    beforeEach(() => {
      process.env.MOCHA_WORKER_ID = '1'
    })
    afterEach(() => {
      delete process.env.MOCHA_WORKER_ID
    })

    it('can export traces', () => {
      const trace = [{ type: 'test' }]
      const traceSecond = [{ type: 'test', name: 'other' }]
      const mochaWorkerExporter = new TestWorkerCiVisibilityExporter()
      mochaWorkerExporter.export(trace)
      mochaWorkerExporter.export(traceSecond)
      mochaWorkerExporter.flush()
      sinon.assert.calledWith(send, [MOCHA_WORKER_TRACE_PAYLOAD_CODE, JSON.stringify([trace, traceSecond])])
    })

    it('does not break if process.send is undefined', () => {
      delete process.send
      const trace = [{ type: 'test' }]
      const mochaWorkerExporter = new TestWorkerCiVisibilityExporter()
      mochaWorkerExporter.export(trace)
      mochaWorkerExporter.flush()
      sinon.assert.notCalled(send)
    })
  })

  context('when the process is a playwright worker', () => {
    beforeEach(() => {
      process.env.DD_PLAYWRIGHT_WORKER = '1'
      process.env.DD_TEST_FAILURE_SCREENSHOTS_ENABLED = 'true'
    })
    afterEach(() => {
      delete process.env.DD_PLAYWRIGHT_WORKER
      delete process.env.DD_TEST_FAILURE_SCREENSHOTS_ENABLED
    })

    it('can export traces', () => {
      const trace = [{ type: 'test' }]
      const traceSecond = [{ type: 'test', name: 'other' }]
      const playwrightWorkerExporter = new TestWorkerCiVisibilityExporter()
      playwrightWorkerExporter.export(trace)
      playwrightWorkerExporter.export(traceSecond)
      playwrightWorkerExporter.flush()
      sinon.assert.calledWith(send, [PLAYWRIGHT_WORKER_TRACE_PAYLOAD_CODE, JSON.stringify([trace, traceSecond])])
    })

    it('does not break if process.send is undefined', () => {
      delete process.send
      const trace = [{ type: 'test' }]
      const playwrightWorkerExporter = new TestWorkerCiVisibilityExporter()
      playwrightWorkerExporter.export(trace)
      playwrightWorkerExporter.flush()
      sinon.assert.notCalled(send)
    })

    it('requests screenshot uploads from the runner process', () => {
      const playwrightWorkerExporter = new TestWorkerCiVisibilityExporter()
      const callback = sinon.spy()
      const options = {
        filePath: '/tmp/test-failed-1.png',
        traceId: '123',
        idempotencyKey: '123:test-failed-1.png',
        capturedAtMs: 1_700_000_000_000,
      }

      playwrightWorkerExporter.uploadTestScreenshot(options, callback)

      const [request] = send.firstCall.args
      assert.strictEqual(request.type, PLAYWRIGHT_WORKER_SCREENSHOT_REQUEST)
      assert.deepStrictEqual(request.options, options)
      sinon.assert.notCalled(callback)

      process.emit('message', {
        type: PLAYWRIGHT_WORKER_SCREENSHOT_RESPONSE,
        requestId: request.requestId,
        uploaded: true,
      })

      sinon.assert.calledOnceWithExactly(callback, undefined, true)
    })

    it('ignores screenshot responses for other requests', () => {
      const playwrightWorkerExporter = new TestWorkerCiVisibilityExporter()
      const callback = sinon.spy()

      playwrightWorkerExporter.uploadTestScreenshot({ filePath: '/tmp/test-failed-1.png' }, callback)

      const [request] = send.firstCall.args
      process.emit('message', {
        type: PLAYWRIGHT_WORKER_SCREENSHOT_RESPONSE,
        requestId: request.requestId + 1,
        uploaded: true,
      })
      sinon.assert.notCalled(callback)

      process.emit('message', {
        type: PLAYWRIGHT_WORKER_SCREENSHOT_RESPONSE,
        requestId: request.requestId,
        uploaded: true,
      })
      sinon.assert.calledOnceWithExactly(callback, undefined, true)
    })

    it('reports when the runner cannot upload screenshots', () => {
      const playwrightWorkerExporter = new TestWorkerCiVisibilityExporter()
      const callback = sinon.spy()

      playwrightWorkerExporter.uploadTestScreenshot({ filePath: '/tmp/test-failed-1.png' }, callback)

      const [request] = send.firstCall.args
      process.emit('message', {
        type: PLAYWRIGHT_WORKER_SCREENSHOT_RESPONSE,
        requestId: request.requestId,
        uploaded: false,
      })

      sinon.assert.calledOnceWithExactly(callback, undefined, false)
    })

    it('reports screenshot upload errors from the runner process', () => {
      const playwrightWorkerExporter = new TestWorkerCiVisibilityExporter()
      const callback = sinon.spy()

      playwrightWorkerExporter.uploadTestScreenshot({ filePath: '/tmp/test-failed-1.png' }, callback)

      const [request] = send.firstCall.args
      process.emit('message', {
        type: PLAYWRIGHT_WORKER_SCREENSHOT_RESPONSE,
        requestId: request.requestId,
        error: 'upload failed',
        uploaded: true,
      })

      sinon.assert.calledOnce(callback)
      assert.match(callback.firstCall.args[0].message, /upload failed/)
      assert.strictEqual(callback.firstCall.args[1], true)
    })

    it('times out screenshot upload requests without a runner response', () => {
      const clock = sinon.useFakeTimers()
      const playwrightWorkerExporter = new TestWorkerCiVisibilityExporter()
      const callback = sinon.spy()
      const initialMessageListenerCount = process.listenerCount('message')

      try {
        playwrightWorkerExporter.uploadTestScreenshot({ filePath: '/tmp/test-failed-1.png' }, callback)

        clock.tick(4999)
        sinon.assert.notCalled(callback)
        clock.tick(1)

        sinon.assert.calledOnce(callback)
        assert.match(callback.firstCall.args[0].message, /Timed out waiting for the Playwright screenshot upload response/)
        assert.strictEqual(callback.firstCall.args[1], true)
        assert.strictEqual(process.listenerCount('message'), initialMessageListenerCount)
      } finally {
        clock.restore()
      }
    })

    it('does not request screenshot uploads without an IPC channel', () => {
      delete process.send
      const playwrightWorkerExporter = new TestWorkerCiVisibilityExporter()
      const callback = sinon.spy()

      playwrightWorkerExporter.uploadTestScreenshot({ filePath: '/tmp/test-failed-1.png' }, callback)

      sinon.assert.calledOnceWithExactly(callback, undefined, false)
      sinon.assert.notCalled(send)
    })

    it('reports asynchronous IPC send errors', () => {
      const sendError = new Error('send failed')
      process.send = sinon.stub().callsFake((message, callback) => callback(sendError))
      const playwrightWorkerExporter = new TestWorkerCiVisibilityExporter()
      const callback = sinon.spy()

      playwrightWorkerExporter.uploadTestScreenshot({ filePath: '/tmp/test-failed-1.png' }, callback)

      sinon.assert.calledOnceWithExactly(callback, sendError, true)
    })

    it('reports synchronous IPC send errors', () => {
      const sendError = new Error('send failed')
      process.send = sinon.stub().throws(sendError)
      const playwrightWorkerExporter = new TestWorkerCiVisibilityExporter()
      const callback = sinon.spy()

      playwrightWorkerExporter.uploadTestScreenshot({ filePath: '/tmp/test-failed-1.png' }, callback)

      sinon.assert.calledOnceWithExactly(callback, sendError, true)
    })
  })

  context('when the process is a vitest worker', () => {
    afterEach(() => {
      delete process.env.DD_VITEST_WORKER
      delete process.env.TINYPOOL_WORKER_ID
      delete globalThis.__vitest_worker__
    })

    it('can export traces (vitest >=4)', () => {
      process.env.DD_VITEST_WORKER = '1'
      const trace = [{ type: 'test' }]
      const traceSecond = [{ type: 'test', name: 'other' }]
      const vitestWorkerExporter = new TestWorkerCiVisibilityExporter()
      vitestWorkerExporter.export(trace)
      vitestWorkerExporter.export(traceSecond)
      vitestWorkerExporter.flush()
      sinon.assert.calledWith(send, [VITEST_WORKER_TRACE_PAYLOAD_CODE, JSON.stringify([trace, traceSecond])])
    })

    it('wraps the payload for legacy tinypool workers (vitest <4)', () => {
      process.env.TINYPOOL_WORKER_ID = '1'
      const trace = [{ type: 'test' }]
      const vitestWorkerExporter = new TestWorkerCiVisibilityExporter()
      vitestWorkerExporter.export(trace)
      vitestWorkerExporter.flush()
      sinon.assert.calledWith(send, {
        __tinypool_worker_message__: true,
        interprocessCode: VITEST_WORKER_TRACE_PAYLOAD_CODE,
        data: JSON.stringify([trace]),
      })
    })

    it('can export traces through the worker port in legacy thread workers (vitest <4)', () => {
      process.env.DD_VITEST_WORKER = '1'
      delete process.send
      const postMessage = sinon.spy()
      const trace = [{ type: 'test' }]
      globalThis.__vitest_worker__ = {
        ctx: {
          port: {
            postMessage,
          },
        },
      }
      const vitestWorkerExporter = new TestWorkerCiVisibilityExporter()
      vitestWorkerExporter.export(trace)
      vitestWorkerExporter.flush()
      sinon.assert.calledWith(postMessage, [VITEST_WORKER_TRACE_PAYLOAD_CODE, JSON.stringify([trace])])
      sinon.assert.notCalled(send)
    })

    it('does not break if process.send is undefined', () => {
      process.env.DD_VITEST_WORKER = '1'
      delete process.send
      const trace = [{ type: 'test' }]
      const vitestWorkerExporter = new TestWorkerCiVisibilityExporter()
      vitestWorkerExporter.export(trace)
      vitestWorkerExporter.flush()
      sinon.assert.notCalled(send)
    })
  })
})
