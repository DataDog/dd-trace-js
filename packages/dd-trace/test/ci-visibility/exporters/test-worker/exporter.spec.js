'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const context = describe
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../../../../dd-trace/test/setup/core')
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

function makeSpan (type = 'test', name = 'vitest.test') {
  return {
    trace_id: id('12345678123456781234567812345678'),
    span_id: id('1234567812345678'),
    parent_id: id('0'),
    name,
    resource: name,
    service: 'tests',
    type,
    error: 0,
    meta: {},
    metrics: {},
    start: 1_700_000_000_000_000_000,
    duration: 1_000_000,
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

    it('batches traces with exact string identifiers until flush', () => {
      const trace = [makeSpan('test', 'first')]
      trace[0].span_id = id('fedcba9876543210')
      trace[0].parent_id = id('abcdef0987654321')
      const traceSecond = [makeSpan('test', 'other')]
      const jestWorkerExporter = new TestWorkerCiVisibilityExporter()
      jestWorkerExporter.export(trace)
      jestWorkerExporter.export(traceSecond)
      sinon.assert.notCalled(send)
      jestWorkerExporter.flush()
      sinon.assert.calledOnce(send)
      assert.deepStrictEqual(send.firstCall.args[0], [
        JEST_WORKER_TRACE_PAYLOAD_CODE, JSON.parse(JSON.stringify([trace, traceSecond])),
      ])
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

      jestWorkerExporter.export([makeSpan()])
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

      jestWorkerExporter.export([makeSpan()])
      jestWorkerExporter.flush(onDone)

      sinon.assert.calledOnceWithExactly(onDone, error)
    })

    it('does not break if process.send is undefined', () => {
      delete process.send
      const trace = [makeSpan()]
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

    it('batches traces with exact string identifiers until flush', () => {
      const trace = [makeSpan('test', 'first')]
      trace[0].span_id = id('fedcba9876543210')
      trace[0].parent_id = id('abcdef0987654321')
      const traceSecond = [makeSpan('test', 'other')]
      const cucumberWorkerExporter = new TestWorkerCiVisibilityExporter()
      cucumberWorkerExporter.export(trace)
      cucumberWorkerExporter.export(traceSecond)
      sinon.assert.notCalled(send)
      cucumberWorkerExporter.flush()
      sinon.assert.calledOnce(send)
      assert.deepStrictEqual(send.firstCall.args[0], [
        CUCUMBER_WORKER_TRACE_PAYLOAD_CODE, JSON.parse(JSON.stringify([trace, traceSecond])),
      ])
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

      cucumberWorkerExporter.export([makeSpan()])
      cucumberWorkerExporter.flush(onDone)

      assert.strictEqual(callbacks.length, 1)
      callbacks[0]()
      sinon.assert.calledOnce(onDone)
    })

    it('does not break if process.send is undefined', () => {
      delete process.send
      const trace = [makeSpan()]
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
      sinon.assert.notCalled(send)
      mochaWorkerExporter.flush()
      sinon.assert.calledWith(send, [MOCHA_WORKER_TRACE_PAYLOAD_CODE, JSON.stringify([trace, traceSecond])])
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
      const writer = new WebdriverioWriter(MOCHA_WORKER_TRACE_PAYLOAD_CODE)
      writer.append(trace)
      writer.flush()

      sinon.assert.calledWith(send, {
        origin: 'datadog',
        name: 'workerEvent',
        args: [MOCHA_WORKER_TRACE_PAYLOAD_CODE, JSON.stringify([trace])],
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
      sinon.assert.notCalled(send)
      playwrightWorkerExporter.flush()
      sinon.assert.calledWith(send, [PLAYWRIGHT_WORKER_TRACE_PAYLOAD_CODE, JSON.stringify([trace, traceSecond])])
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
      delete process.env.DD_CIVISIBILITY_AGENTLESS_ENABLED
      delete globalThis.__vitest_worker__
    })

    for (const workerEnv of ['DD_VITEST_WORKER', 'TINYPOOL_WORKER_ID']) {
      for (const transport of ['process', 'port']) {
        it(`flushes each trace immediately with ${workerEnv} over ${transport}`, () => {
          process.env[workerEnv] = '1'
          const postMessage = sinon.spy()
          if (transport === 'port') {
            delete process.send
            globalThis.__vitest_worker__ = { ctx: { port: { postMessage } } }
          }
          const sendTrace = transport === 'port' ? postMessage : send
          const traces = [
            [makeSpan('test', 'first'), makeSpan('web', 'child span')],
            [makeSpan('test', 'retry')],
            [makeSpan('test_suite_end')],
          ]
          const exporter = new TestWorkerCiVisibilityExporter()

          for (const [index, trace] of traces.entries()) {
            exporter.export(trace)

            assert.strictEqual(sendTrace.callCount, index + 1)
            const data = JSON.parse(JSON.stringify([trace]))
            const message = workerEnv === 'TINYPOOL_WORKER_ID'
              ? { __tinypool_worker_message__: true, interprocessCode: VITEST_WORKER_TRACE_PAYLOAD_CODE, data }
              : [VITEST_WORKER_TRACE_PAYLOAD_CODE, data]
            assert.deepStrictEqual(sendTrace.lastCall.args[0], message)
          }

          exporter.flush()
          exporter.flush()
          assert.strictEqual(sendTrace.callCount, traces.length)
          if (transport === 'port') sinon.assert.notCalled(send)
        })
      }
    }

    it('drops non-finite metrics and normalizes negative zero for intake', () => {
      process.env.DD_VITEST_WORKER = '1'
      const span = makeSpan()
      span.metrics = { nan: NaN, positive: Infinity, negative: -Infinity, finite: 1, url: 'https://example.com' }
      const zeroSpan = makeSpan()
      zeroSpan.metrics = { signedZero: -0 }
      const trace = [span, zeroSpan]
      const expected = JSON.parse(JSON.stringify([trace]))
      expected[0][0].metrics = { finite: 1, url: 'https://example.com' }
      const exporter = new TestWorkerCiVisibilityExporter()

      exporter.export(trace)

      assert.deepStrictEqual(send.firstCall.args[0], [VITEST_WORKER_TRACE_PAYLOAD_CODE, expected])
      assert.ok(Number.isNaN(span.metrics.nan))
      assert.strictEqual(zeroSpan.metrics.signedZero, -0)
    })

    it('preserves JSON conversion of structured metadata and span events for the Agent fallback', () => {
      process.env.DD_VITEST_WORKER = '1'
      const metadataSpan = makeSpan()
      metadataSpan.meta_struct = {
        nested: {
          omitted: undefined,
          values: [undefined, Infinity, -0, new Date('2026-01-01T00:00:00.000Z')],
          bytes: Buffer.from([1, 2]),
          custom: { toJSON: key => ({ key, value: '🎉' }) },
        },
      }
      const eventSpan = makeSpan()
      eventSpan.span_events = [{ name: 'event', startTime: 1_700_000_000_000, attributes: { value: Infinity } }]
      const trace = [metadataSpan, eventSpan]
      const expected = JSON.parse(JSON.stringify([trace]))
      const exporter = new TestWorkerCiVisibilityExporter()

      exporter.export(trace)

      assert.deepStrictEqual(send.firstCall.args[0], [VITEST_WORKER_TRACE_PAYLOAD_CODE, expected])
      assert.strictEqual(metadataSpan.meta_struct.nested.values[1], Infinity)
      assert.strictEqual(eventSpan.span_events[0].attributes.value, Infinity)
    })

    it('omits structured metadata and span events that the agentless intake does not use', () => {
      process.env.DD_VITEST_WORKER = '1'
      process.env.DD_CIVISIBILITY_AGENTLESS_ENABLED = '1'
      const span = makeSpan()
      const expected = JSON.parse(JSON.stringify([[span]]))
      const toJSON = sinon.spy()
      span.meta_struct = { nested: { toJSON } }
      span.span_events = [{ name: 'event', startTime: 1_700_000_000_000 }]
      const exporter = new TestWorkerCiVisibilityExporter()

      exporter.export([span])

      assert.deepStrictEqual(send.firstCall.args[0], [VITEST_WORKER_TRACE_PAYLOAD_CODE, expected])
      sinon.assert.notCalled(toJSON)
    })

    it('waits for all automatically flushed traces before signaling final completion', () => {
      process.env.DD_VITEST_WORKER = '1'
      const callbacks = []
      process.send = sinon.stub().callsFake((payload, callback) => callbacks.push(callback))
      const exporter = new TestWorkerCiVisibilityExporter()
      const onDone = sinon.spy()
      const onDoneSecond = sinon.spy()

      exporter.export([makeSpan('test', 'first')])
      exporter.export([makeSpan('test', 'second')])
      exporter.exportCoverage({ sessionId: '1', suiteId: '1', files: ['test.js'] })
      exporter.flush(onDone)
      exporter.flush(onDoneSecond)

      assert.strictEqual(callbacks.length, 3)
      sinon.assert.notCalled(onDone)
      callbacks[2]()
      callbacks[1]()
      sinon.assert.notCalled(onDone)
      sinon.assert.notCalled(onDoneSecond)
      callbacks[0]()
      sinon.assert.calledOnceWithExactly(onDone, undefined)
      sinon.assert.calledOnceWithExactly(onDoneSecond, undefined)
    })

    for (const timing of ['before', 'after']) {
      it(`reports a trace send error received ${timing} the final flush`, () => {
        process.env.DD_VITEST_WORKER = '1'
        const error = new Error('IPC channel closed')
        let onSent
        process.send = sinon.stub().callsFake((payload, callback) => { onSent = callback })
        const exporter = new TestWorkerCiVisibilityExporter()
        const onDone = sinon.spy()

        exporter.export([makeSpan()])
        if (timing === 'before') onSent(error)
        exporter.flush(onDone)
        if (timing === 'after') {
          sinon.assert.notCalled(onDone)
          onSent(error)
        }
        sinon.assert.calledOnceWithExactly(onDone, error)

        process.send = sinon.stub().callsFake((payload, callback) => callback())
        const onDoneSecond = sinon.spy()
        exporter.export([makeSpan('test', 'second')])
        exporter.flush(onDoneSecond)
        sinon.assert.calledOnceWithExactly(onDoneSecond, undefined)
      })
    }

    it('keeps coverage and telemetry queued when sending a trace', () => {
      process.env.DD_VITEST_WORKER = '1'
      const exporter = new TestWorkerCiVisibilityExporter()
      exporter.exportCoverage({ sessionId: '1', suiteId: '1', files: ['test.js'] })
      exporter.exportTelemetry({ type: 'ciVisEvent', name: 'test_event' })
      exporter.export([makeSpan()])

      sinon.assert.calledOnce(send)
      assert.strictEqual(send.firstCall.args[0][0], VITEST_WORKER_TRACE_PAYLOAD_CODE)
      exporter.flush()
      assert.deepStrictEqual(send.getCalls().map(call => call.args[0][0]), [
        VITEST_WORKER_TRACE_PAYLOAD_CODE,
        VITEST_WORKER_COVERAGE_PAYLOAD_CODE,
        VITEST_WORKER_TELEMETRY_PAYLOAD_CODE,
      ])
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

    it('does not break if process.send is undefined', () => {
      process.env.DD_VITEST_WORKER = '1'
      delete process.send
      const trace = [makeSpan()]
      const vitestWorkerExporter = new TestWorkerCiVisibilityExporter()
      vitestWorkerExporter.export(trace)
      vitestWorkerExporter.flush()
      sinon.assert.notCalled(send)
    })
  })
})
