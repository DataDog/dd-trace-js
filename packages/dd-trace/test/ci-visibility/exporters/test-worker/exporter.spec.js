'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const context = describe
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../../../../dd-trace/test/setup/core')
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
      sinon.assert.notCalled(send)
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
      sinon.assert.notCalled(send)
      cucumberWorkerExporter.flush()
      sinon.assert.calledWith(send, [CUCUMBER_WORKER_TRACE_PAYLOAD_CODE, JSON.stringify([trace, traceSecond])])
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
            [{ type: 'test', name: 'first' }, { name: 'child span' }],
            [{ type: 'test', name: 'retry' }],
            [{ type: 'test_suite_end' }],
          ]
          const exporter = new TestWorkerCiVisibilityExporter()

          for (const [index, trace] of traces.entries()) {
            exporter.export(trace)

            assert.strictEqual(sendTrace.callCount, index + 1)
            const data = JSON.stringify([trace])
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

    it('waits for all automatically flushed traces before signaling final completion', () => {
      process.env.DD_VITEST_WORKER = '1'
      const callbacks = []
      process.send = sinon.stub().callsFake((payload, callback) => callbacks.push(callback))
      const exporter = new TestWorkerCiVisibilityExporter()
      const onDone = sinon.spy()
      const onDoneSecond = sinon.spy()

      exporter.export([{ type: 'test', name: 'first' }])
      exporter.export([{ type: 'test', name: 'second' }])
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

        exporter.export([{ type: 'test' }])
        if (timing === 'before') onSent(error)
        exporter.flush(onDone)
        if (timing === 'after') {
          sinon.assert.notCalled(onDone)
          onSent(error)
        }
        sinon.assert.calledOnceWithExactly(onDone, error)

        process.send = sinon.stub().callsFake((payload, callback) => callback())
        const onDoneSecond = sinon.spy()
        exporter.export([{ type: 'test', name: 'second' }])
        exporter.flush(onDoneSecond)
        sinon.assert.calledOnceWithExactly(onDoneSecond, undefined)
      })
    }

    it('keeps coverage and telemetry queued when sending a trace', () => {
      process.env.DD_VITEST_WORKER = '1'
      const exporter = new TestWorkerCiVisibilityExporter()
      exporter.exportCoverage({ sessionId: '1', suiteId: '1', files: ['test.js'] })
      exporter.exportTelemetry({ type: 'ciVisEvent', name: 'test_event' })
      exporter.export([{ type: 'test' }])

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
      const trace = [{ type: 'test' }]
      const vitestWorkerExporter = new TestWorkerCiVisibilityExporter()
      vitestWorkerExporter.export(trace)
      vitestWorkerExporter.flush()
      sinon.assert.notCalled(send)
    })
  })
})
