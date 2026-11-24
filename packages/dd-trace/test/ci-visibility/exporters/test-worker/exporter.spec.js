'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { Worker } = require('node:worker_threads')

const { describe, it, beforeEach, afterEach } = require('mocha')
const context = describe
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../../../../dd-trace/test/setup/core')
const { decodeWorkerTraces } = require('../../../../src/ci-visibility/encode/worker-traces')
const Writer = require('../../../../src/ci-visibility/exporters/test-worker/writer')
const id = require('../../../../src/id')
const TestWorkerCiVisibilityExporter = proxyquire('../../../../src/ci-visibility/exporters/test-worker', {
  '../../../config': () => {
    const loadConfig = proxyquire.noPreserveCache()
    const createConfig = loadConfig('../../../../src/config', {})
    return createConfig()
  },
})

const {
  JEST_WORKER_TRACE_PAYLOAD_CODE,
  JEST_WORKER_COVERAGE_PAYLOAD_CODE,
  CUCUMBER_WORKER_TRACE_PAYLOAD_CODE,
  CUCUMBER_WORKER_TELEMETRY_PAYLOAD_CODE,
  MOCHA_WORKER_LOGS_PAYLOAD_CODE,
  MOCHA_WORKER_TELEMETRY_PAYLOAD_CODE,
  MOCHA_WORKER_TRACE_PAYLOAD_CODE,
  PLAYWRIGHT_WORKER_TELEMETRY_PAYLOAD_CODE,
  PLAYWRIGHT_WORKER_TRACE_PAYLOAD_CODE,
  VITEST_WORKER_TRACE_PAYLOAD_CODE,
  VITEST_WORKER_COVERAGE_PAYLOAD_CODE,
  VITEST_WORKER_TELEMETRY_PAYLOAD_CODE,
} = require('../../../../src/plugins/util/test')

function testSpan () {
  return {
    trace_id: id('abcdef0123456789'),
    span_id: id('0123456789abcdef'),
    parent_id: id('0'),
    name: 'test',
    resource: 'test',
    service: 'service',
    type: 'test',
    error: 0,
    start: 1,
    duration: 2,
    meta: { value: '\x00é' },
    metrics: { value: 1.5 },
    trace_state: 'dd=s:1',
  }
}

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
      sinon.assert.calledWith(send,
        [JEST_WORKER_TRACE_PAYLOAD_CODE, [JSON.stringify(trace), JSON.stringify(traceSecond)]]
      )
    })

    it('sends plain traces without stringifying them and keeps rich traces in the same batch', () => {
      const span = testSpan()
      const rich = [{ ...span, meta_struct: { date: new Date(0) } }]
      const nonFinite = [{ ...span, metrics: { value: NaN } }]
      const optional = [{ ...span, service: undefined, type: undefined, trace_state: undefined }]
      const exporter = new TestWorkerCiVisibilityExporter()

      exporter.export([span])
      exporter.export(rich)
      exporter.export(nonFinite)
      exporter.export(optional)
      exporter.flush()

      const [code, traces] = send.firstCall.args[0]
      assert.strictEqual(code, JEST_WORKER_TRACE_PAYLOAD_CODE)
      assert.ok(Array.isArray(traces[0]))
      assert.strictEqual(traces[1], JSON.stringify(rich))
      assert.strictEqual(traces[2], JSON.stringify(nonFinite))
      const jsonTransport = JSON.parse(JSON.stringify(traces))
      const expected = JSON.parse(JSON.stringify([[span], rich, nonFinite, optional]))
      assert.deepStrictEqual(decodeWorkerTraces(traces), expected)
      assert.deepStrictEqual(decodeWorkerTraces(jsonTransport), expected)
      sinon.assert.calledOnce(send)
    })

    it('sends a packed singleton over the batch target after pending traces', () => {
      const smallSpan = testSpan()
      const largeSpan = testSpan()
      largeSpan.meta.value = 'x'.repeat(1024 * 1024)
      const exporter = new TestWorkerCiVisibilityExporter()

      exporter.export([smallSpan])
      sinon.assert.notCalled(send)
      exporter.export([largeSpan])

      sinon.assert.calledTwice(send)
      for (const [index, span] of [smallSpan, largeSpan].entries()) {
        const [code, traces] = send.args[index][0]
        assert.strictEqual(code, JEST_WORKER_TRACE_PAYLOAD_CODE)
        assert.ok(Array.isArray(traces[0]))
        assert.deepStrictEqual(decodeWorkerTraces(traces), JSON.parse(JSON.stringify([[span]])))
      }

      exporter.flush()
      sinon.assert.calledTwice(send)
    })

    it('sends trace batches in order and waits for all of them even with an empty tail', () => {
      const trace = [{ type: 'test', meta: { value: 'é'.repeat(3 * 512 * 1024) } }]
      const oversizedTrace = [{ type: 'test', meta: { value: '\x00'.repeat(2 * 1024 * 1024) } }]
      const exporter = new TestWorkerCiVisibilityExporter()
      const onDone = sinon.spy()

      exporter.export(trace)
      sinon.assert.notCalled(send)
      exporter.export(trace)
      exporter.export(oversizedTrace)
      sinon.assert.callCount(send, 3)

      exporter.flush(onDone)
      sinon.assert.callCount(send, 3)
      const [first, second, third] = send.args
      assert.deepStrictEqual(first[0], [JEST_WORKER_TRACE_PAYLOAD_CODE, [JSON.stringify(trace)]])
      assert.deepStrictEqual(second[0], first[0])
      assert.deepStrictEqual(third[0], [JEST_WORKER_TRACE_PAYLOAD_CODE, [JSON.stringify(oversizedTrace)]])

      const error = new Error('IPC channel closed')
      third[1](error)
      first[1]()
      sinon.assert.notCalled(onDone)
      second[1]()
      sinon.assert.calledOnceWithExactly(onDone, error)

      const nextDone = sinon.spy()
      exporter.flush(nextDone)
      sinon.assert.calledOnceWithExactly(nextDone, undefined)
    })

    it('keeps neighboring traces when one trace cannot be serialized', () => {
      const exporter = new TestWorkerCiVisibilityExporter()
      const first = [{ name: 'first' }]
      const invalid = []
      const last = [{ name: 'last' }]
      invalid.push(invalid)

      exporter.export(first)
      exporter.export(invalid)
      exporter.export(last)
      exporter.flush()

      sinon.assert.calledOnceWithExactly(
        send,
        [JEST_WORKER_TRACE_PAYLOAD_CODE, [JSON.stringify(first), JSON.stringify(last)]],
        sinon.match.func
      )
    })

    it('completes a flush when the transport throws synchronously', () => {
      const error = new Error('cannot write IPC message')
      process.send = sinon.stub().throws(error)
      const exporter = new TestWorkerCiVisibilityExporter()
      const onDone = sinon.spy()

      exporter.export([{ name: 'test' }])
      exporter.flush(onDone)

      sinon.assert.calledOnceWithExactly(onDone, error)
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

    it('reports an IPC send error after all writers settle', () => {
      const error = new Error('IPC channel closed')
      process.send = sinon.stub().callsFake((payload, callback) => callback(error))
      const jestWorkerExporter = new TestWorkerCiVisibilityExporter()
      const onDone = sinon.spy()

      jestWorkerExporter.export([{ type: 'test' }])
      jestWorkerExporter.flush(onDone)

      sinon.assert.calledOnceWithExactly(onDone, error)
    })

    it('does not break if process.send is undefined', () => {
      delete process.send
      const trace = [{ type: 'test' }]
      const jestWorkerExporter = new TestWorkerCiVisibilityExporter()
      jestWorkerExporter.export(trace)
      jestWorkerExporter.flush()
      sinon.assert.notCalled(send)
    })

    it('sends traces to the parent port in a worker thread', async () => {
      const worker = new Worker(`
        const { workerData } = require('node:worker_threads')
        const Exporter = require(workerData)
        const exporter = new Exporter()
        exporter.export([{ name: 'test' }])
        exporter.flush()
      `, {
        eval: true,
        workerData: require.resolve('../../../../src/ci-visibility/exporters/test-worker'),
      })
      const messages = []
      worker.on('message', message => messages.push(message))

      const [exitCode] = await once(worker, 'exit')
      assert.strictEqual(exitCode, 0)
      assert.deepStrictEqual(messages, [[JEST_WORKER_TRACE_PAYLOAD_CODE, ['[{"name":"test"}]']]])
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
      sinon.assert.calledWith(send,
        [CUCUMBER_WORKER_TRACE_PAYLOAD_CODE, [JSON.stringify(trace), JSON.stringify(traceSecond)]]
      )
    })

    it('can export telemetry', () => {
      const telemetry = { type: 'ciVisEvent', name: 'test_event' }
      const cucumberWorkerExporter = new TestWorkerCiVisibilityExporter()
      cucumberWorkerExporter.exportTelemetry(telemetry)
      cucumberWorkerExporter.flush()
      sinon.assert.calledWith(
        send,
        [CUCUMBER_WORKER_TELEMETRY_PAYLOAD_CODE, JSON.stringify([telemetry])]
      )
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
      sinon.assert.calledWith(send,
        [MOCHA_WORKER_TRACE_PAYLOAD_CODE, [JSON.stringify(trace), JSON.stringify(traceSecond)]]
      )
    })

    it('can export telemetry', () => {
      const telemetry = { type: 'ciVisEvent', name: 'test_event' }
      const mochaWorkerExporter = new TestWorkerCiVisibilityExporter()
      mochaWorkerExporter.exportTelemetry(telemetry)
      mochaWorkerExporter.flush()
      sinon.assert.calledWith(send, [MOCHA_WORKER_TELEMETRY_PAYLOAD_CODE, JSON.stringify([telemetry])])
    })

    it('can export DI logs', () => {
      process.env.MOCHA_WORKER_ID = 'webdriverio'
      const testEnvironmentMetadata = { testFramework: 'webdriverio' }
      const logMessage = { message: 'test log' }
      const mochaWorkerExporter = new TestWorkerCiVisibilityExporter()

      mochaWorkerExporter.exportDiLogs(testEnvironmentMetadata, logMessage)
      mochaWorkerExporter.flush()

      sinon.assert.calledWith(send, [
        MOCHA_WORKER_LOGS_PAYLOAD_CODE,
        JSON.stringify([{ testEnvironmentMetadata, logMessage }]),
      ])
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

  context('when writing from a WebdriverIO worker', () => {
    it('wraps traces in a filtered WebdriverIO worker event', () => {
      const trace = [{ type: 'test' }]
      const WebdriverioWriter = proxyquire('../../../../src/ci-visibility/exporters/test-worker/writer', {
        '../../../config/helper': {
          getEnvironmentVariable: name =>
            name === '_DD_TEST_OPTIMIZATION_WEBDRIVERIO_WORKER' ? 'true' : undefined,
        },
      })
      const writer = new WebdriverioWriter(MOCHA_WORKER_TRACE_PAYLOAD_CODE, 1024)
      writer.append(trace)
      writer.flush()

      sinon.assert.calledWith(send, {
        origin: 'datadog',
        name: 'workerEvent',
        args: [MOCHA_WORKER_TRACE_PAYLOAD_CODE, [JSON.stringify(trace)]],
      })
    })
  })

  context('when the process is a playwright worker', () => {
    beforeEach(() => {
      process.env.DD_PLAYWRIGHT_WORKER = '1'
    })
    afterEach(() => {
      delete process.env.DD_PLAYWRIGHT_WORKER
    })

    it('can export traces', () => {
      const trace = [{ type: 'test' }]
      const traceSecond = [{ type: 'test', name: 'other' }]
      const playwrightWorkerExporter = new TestWorkerCiVisibilityExporter()
      playwrightWorkerExporter.export(trace)
      playwrightWorkerExporter.export(traceSecond)
      playwrightWorkerExporter.flush()
      sinon.assert.calledWith(send,
        [PLAYWRIGHT_WORKER_TRACE_PAYLOAD_CODE, [JSON.stringify(trace), JSON.stringify(traceSecond)]]
      )
    })

    it('can export telemetry', () => {
      const telemetry = { type: 'ciVisEvent', name: 'test_event' }
      const playwrightWorkerExporter = new TestWorkerCiVisibilityExporter()
      playwrightWorkerExporter.exportTelemetry(telemetry)
      playwrightWorkerExporter.flush()
      sinon.assert.calledWith(send, [PLAYWRIGHT_WORKER_TELEMETRY_PAYLOAD_CODE, JSON.stringify([telemetry])])
    })

    it('does not break if process.send is undefined', () => {
      delete process.send
      const trace = [{ type: 'test' }]
      const playwrightWorkerExporter = new TestWorkerCiVisibilityExporter()
      playwrightWorkerExporter.export(trace)
      playwrightWorkerExporter.flush()
      sinon.assert.notCalled(send)
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
      sinon.assert.calledWith(send,
        [VITEST_WORKER_TRACE_PAYLOAD_CODE, [JSON.stringify(trace), JSON.stringify(traceSecond)]]
      )
    })

    it('can export coverages', () => {
      process.env.DD_VITEST_WORKER = '1'
      const coverage = { sessionId: '1', suiteId: '1', files: ['test.js'] }
      const coverageSecond = { sessionId: '2', suiteId: '2', files: ['test2.js'] }
      const vitestWorkerExporter = new TestWorkerCiVisibilityExporter()
      vitestWorkerExporter.exportCoverage(coverage)
      vitestWorkerExporter.exportCoverage(coverageSecond)
      vitestWorkerExporter.flush()
      sinon.assert.calledWith(send,
        [VITEST_WORKER_COVERAGE_PAYLOAD_CODE, JSON.stringify([coverage, coverageSecond])]
      )
    })

    it('can export telemetry', () => {
      process.env.DD_VITEST_WORKER = '1'
      const telemetry = { type: 'ciVisEvent', name: 'code_coverage_started' }
      const vitestWorkerExporter = new TestWorkerCiVisibilityExporter()
      vitestWorkerExporter.exportTelemetry(telemetry)
      vitestWorkerExporter.flush()
      sinon.assert.calledWith(
        send,
        [VITEST_WORKER_TELEMETRY_PAYLOAD_CODE, JSON.stringify([telemetry])]
      )
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
        data: [JSON.stringify(trace)],
      })
    })

    it('splits JSON worker batches one byte over 4 MiB', () => {
      process.env.TINYPOOL_WORKER_ID = '1'
      const first = [{ type: 'test', name: '' }]
      const encodedFirst = JSON.stringify(first)
      const frame = {
        __tinypool_worker_message__: true,
        interprocessCode: VITEST_WORKER_TRACE_PAYLOAD_CODE,
        data: [encodedFirst, encodedFirst],
      }
      const remainingBytes = 4 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(frame)) - 1

      for (const extraBytes of [0, 1]) {
        send.resetHistory()
        const second = [{ type: 'test', name: 'x'.repeat(remainingBytes + extraBytes) }]
        const encodedSecond = JSON.stringify(second)
        const exporter = new TestWorkerCiVisibilityExporter()

        exporter.export(first)
        exporter.export(second)
        exporter.flush()

        const frames = send.args.map(([message]) => message.data)
        const expected = extraBytes === 0 ? [[encodedFirst, encodedSecond]] : [[encodedFirst], [encodedSecond]]
        assert.strictEqual(frames.length, expected.length)
        assert.deepStrictEqual(frames, expected)
      }
    })

    it('splits an escaped fallback frame one byte over the budget', () => {
      process.env.TINYPOOL_WORKER_ID = '1'
      const span = testSpan()
      const traces = [[{ ...span, meta: { value: 'x'.repeat(1024) + '\x00\\"é😀\ud800' } }]]
      if (typeof JSON.rawJSON === 'function') {
        traces.push([{ ...span, meta_struct: { value: JSON.rawJSON('"\ud800x\udc00"') } }])
      }

      for (const trace of traces) {
        const encoded = JSON.stringify(trace)
        const single = {
          __tinypool_worker_message__: true,
          interprocessCode: VITEST_WORKER_TRACE_PAYLOAD_CODE,
          data: [encoded],
        }
        const pair = { ...single, data: [encoded, encoded] }
        const frameBytes = Buffer.byteLength(JSON.stringify(pair)) + 1

        for (const bytesOverLimit of [0, 1]) {
          send.resetHistory()
          const byteLimit = frameBytes - bytesOverLimit
          const writer = new Writer(VITEST_WORKER_TRACE_PAYLOAD_CODE, byteLimit)

          writer.append(trace)
          sinon.assert.notCalled(send)
          writer.append(trace)
          writer.flush()

          const frames = send.args.map(([message]) => message)
          assert.strictEqual(frames.length, bytesOverLimit + 1)
          assert.deepStrictEqual(frames, bytesOverLimit === 0 ? [pair] : [single, single])
          for (const message of frames) {
            assert.ok(Buffer.byteLength(JSON.stringify(message)) + 1 <= byteLimit)
          }
        }
      }
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
      sinon.assert.calledWith(postMessage, [VITEST_WORKER_TRACE_PAYLOAD_CODE, [JSON.stringify(trace)]])
      sinon.assert.notCalled(send)
    })

    it('reports a synchronous Vitest port error to the flush callback', () => {
      process.env.DD_VITEST_WORKER = '1'
      const error = new Error('cannot post message')
      const postMessage = sinon.stub().throws(error)
      globalThis.__vitest_worker__ = { ctx: { port: { postMessage } } }
      const exporter = new TestWorkerCiVisibilityExporter()
      const onDone = sinon.spy()

      exporter.export([{ name: 'test' }])
      exporter.flush(onDone)

      sinon.assert.calledOnce(postMessage)
      sinon.assert.calledOnceWithExactly(onDone, error)
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
