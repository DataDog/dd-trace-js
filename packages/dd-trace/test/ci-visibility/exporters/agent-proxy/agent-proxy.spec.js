'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { describe, it, beforeEach } = require('mocha')
const context = describe
const sinon = require('sinon')
const nock = require('nock')
const proxyquire = require('proxyquire')

const { assertObjectContains } = require('../../../../../../integration-tests/helpers')
require('../../../../../dd-trace/test/setup/core')
const AgentProxyCiVisibilityExporterBase = require('../../../../src/ci-visibility/exporters/agent-proxy')
const { FINAL_FLUSH_TIMEOUT } = require('../../../../src/ci-visibility/final-flush')
const AgentlessWriter = require('../../../../src/ci-visibility/exporters/agentless/writer')
const DynamicInstrumentationLogsWriter = require('../../../../src/ci-visibility/exporters/agentless/di-logs-writer')
const CoverageWriter = require('../../../../src/ci-visibility/exporters/agentless/coverage-writer')
const AgentWriter = require('../../../../src/exporters/agent/writer')
const { clearCache } = require('../../../../src/agent/info')
const { defaults: { hostname, port } } = require('../../../../src/config/defaults')

// The real tracer Config always carries a `testOptimization` namespace object.
// Default it here so the partial config stand-ins below mirror that guarantee.
class AgentProxyCiVisibilityExporter extends AgentProxyCiVisibilityExporterBase {
  constructor (config) {
    super({ testOptimization: {}, ...config })
  }
}

describe('AgentProxyCiVisibilityExporter', () => {
  beforeEach(() => {
    nock.abortPendingRequests()
    nock.cleanAll()
    clearCache()
  })

  const flushInterval = 50
  const url = new URL(`http://${hostname}:${port}`)
  const queryDelay = 50
  const tags = {}

  function createControlledExporter () {
    const writers = []
    let finishAgentInfo
    let requestOptions

    class Writer {
      constructor () {
        this.append = sinon.spy()
        this.flush = sinon.spy(done => done?.())
        writers.push(this)
      }
    }

    const ControlledExporterBase = proxyquire('../../../../src/ci-visibility/exporters/agent-proxy', {
      '../../../agent/info': {
        fetchAgentInfo (agentUrl, callback, options) {
          finishAgentInfo = callback
          requestOptions = options
        },
      },
      '../../../exporters/agent/writer': Writer,
      '../agentless/writer': Writer,
      '../agentless/coverage-writer': Writer,
    })
    class ControlledExporter extends ControlledExporterBase {
      constructor (config) {
        super({ testOptimization: {}, ...config })
      }
    }

    const exporter = new ControlledExporter({ url, tags })
    return {
      exporter,
      finishAgentInfo (...args) {
        finishAgentInfo(...args)
      },
      getRequestOptions () {
        return requestOptions
      },
      writers,
    }
  }

  it('should query /info right when it is instantiated', async () => {
    const scope = nock(url)
      .get('/info')
      .reply(200, JSON.stringify({
        endpoints: ['/evp_proxy/v2'],
      }))

    const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ url, tags })

    assert.notStrictEqual(agentProxyCiVisibilityExporter, null)
    await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
    assert.strictEqual(scope.isDone(), true)
  })

  it('retries agent info initialization within the final flush timeout', () => {
    const clock = sinon.useFakeTimers()
    try {
      const controlled = createControlledExporter()

      assert.strictEqual(controlled.getRequestOptions().deadline, Date.now() + FINAL_FLUSH_TIMEOUT)
    } finally {
      clock.restore()
    }
  })

  it('exports buffered data and flushes it when initialization finishes within the final deadline', async () => {
    const clock = sinon.useFakeTimers()
    try {
      const controlled = createControlledExporter()
      const trace = [{ type: 'test' }]
      const done = sinon.spy()

      controlled.exporter.export(trace)
      controlled.exporter.flush(done)

      const requestOptions = controlled.getRequestOptions()
      assert.strictEqual(requestOptions.keepProcessAlive, true)
      assert.strictEqual(requestOptions.timeoutFromCreation, false)
      assert.strictEqual(requestOptions.signal.aborted, false)
      assert.strictEqual(requestOptions.deadline, Date.now() + FINAL_FLUSH_TIMEOUT)

      controlled.finishAgentInfo(null, { endpoints: ['/evp_proxy/v2'] })
      await Promise.resolve()

      assert.strictEqual(controlled.writers.length, 2)
      sinon.assert.calledOnceWithExactly(controlled.writers[0].append, trace)
      for (const writer of controlled.writers) {
        sinon.assert.calledOnce(writer.flush)
        assert.strictEqual(writer.flush.firstCall.args[1].deadline, requestOptions.deadline)
      }
      sinon.assert.calledOnceWithExactly(done, undefined)
    } finally {
      clock.restore()
    }
  })

  it('exports suite events before buffered module and session events after initialization', async () => {
    const controlled = createControlledExporter()
    const suiteEvent = { type: 'test_suite_end', span_id: '1' }
    const moduleAndSessionEvents = [
      { type: 'test_module_end' },
      { type: 'test_session_end' },
    ]
    const done = sinon.spy()

    controlled.exporter.export([suiteEvent])
    controlled.exporter.export(moduleAndSessionEvents)
    controlled.exporter.flush(done)

    controlled.finishAgentInfo(null, { endpoints: ['/evp_proxy/v2'] })
    await Promise.resolve()

    sinon.assert.calledWithExactly(controlled.writers[0].append.firstCall, [suiteEvent])
    sinon.assert.calledWithExactly(controlled.writers[0].append.secondCall, moduleAndSessionEvents)
    sinon.assert.calledOnceWithExactly(done, undefined)
  })

  it('aborts initialization and uses the fallback writer for later sessions', async () => {
    const clock = sinon.useFakeTimers()
    try {
      const controlled = createControlledExporter()
      const firstDone = sinon.spy()
      const firstTrace = [{ type: 'test' }]
      const firstCoverage = { traceId: '1', spanId: '1', files: [] }

      controlled.exporter.export(firstTrace)
      controlled.exporter.exportCoverage(firstCoverage)
      controlled.exporter.flush(firstDone)
      const { signal } = controlled.getRequestOptions()

      clock.tick(FINAL_FLUSH_TIMEOUT)

      assert.strictEqual(signal.aborted, true)
      assert.strictEqual(signal.reason.code, 'ERR_DD_TEST_OPTIMIZATION_FLUSH_TIMEOUT')
      sinon.assert.calledOnceWithExactly(firstDone, signal.reason)

      controlled.finishAgentInfo(signal.reason)
      await Promise.resolve()
      clock.tick(100)

      sinon.assert.calledOnce(firstDone)
      assert.strictEqual(controlled.writers.length, 1)
      sinon.assert.notCalled(controlled.writers[0].append)
      assert.deepStrictEqual(controlled.exporter.getUncodedTraces(), [])
      assert.deepStrictEqual(controlled.exporter._coverageBuffer, [])

      const secondDone = sinon.spy()
      const secondTrace = [{ type: 'test' }]
      controlled.exporter.export(secondTrace)
      controlled.exporter.flush(secondDone)

      sinon.assert.calledOnceWithExactly(controlled.writers[0].append, secondTrace)
      sinon.assert.calledOnce(controlled.writers[0].flush)
      sinon.assert.calledOnceWithExactly(secondDone, undefined)
    } finally {
      clock.restore()
    }
  })

  it('keeps overlapping initialization owned by the latest final flush', async () => {
    const clock = sinon.useFakeTimers()
    try {
      const controlled = createControlledExporter()
      const firstDone = sinon.spy()
      const firstTrace = [{ type: 'test', name: 'first session' }]
      const overlapDelay = FINAL_FLUSH_TIMEOUT / 2

      controlled.exporter.export(firstTrace)
      controlled.exporter.flush(firstDone)
      const requestOptions = controlled.getRequestOptions()

      clock.tick(overlapDelay)

      const secondDone = sinon.spy()
      const secondTrace = [{ type: 'test', name: 'second session' }]
      controlled.exporter.export(secondTrace)
      controlled.exporter.flush(secondDone)

      assert.strictEqual(requestOptions.deadline, Date.now() + FINAL_FLUSH_TIMEOUT)

      clock.tick(overlapDelay)

      assert.strictEqual(requestOptions.signal.aborted, false)
      sinon.assert.calledOnce(firstDone)
      assert.strictEqual(firstDone.firstCall.args[0].code, 'ERR_DD_TEST_OPTIMIZATION_FLUSH_TIMEOUT')
      sinon.assert.notCalled(secondDone)

      controlled.finishAgentInfo(new Error('agent info unavailable'))
      await Promise.resolve()

      assert.strictEqual(controlled.writers.length, 1)
      sinon.assert.calledWithExactly(controlled.writers[0].append.firstCall, firstTrace)
      sinon.assert.calledWithExactly(controlled.writers[0].append.secondCall, secondTrace)
      sinon.assert.calledOnce(controlled.writers[0].flush)
      sinon.assert.calledOnceWithExactly(secondDone, undefined)

      clock.tick(20_000)
      sinon.assert.calledOnce(firstDone)
      sinon.assert.calledOnce(secondDone)
    } finally {
      clock.restore()
    }
  })

  it('should store traces and coverages as is until the query to /info is resolved', async () => {
    nock(url)
      .get('/info')
      .delay(queryDelay)
      .reply(200, JSON.stringify({
        endpoints: ['/evp_proxy/v2/'],
      }))
    const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ url, tags })

    const trace = [{ span_id: '1234' }]
    const coverage = {
      traceId: '1',
      spanId: '2',
      files: ['example.js'],
    }
    agentProxyCiVisibilityExporter.export(trace)
    agentProxyCiVisibilityExporter.exportCoverage(coverage)

    assertObjectContains(agentProxyCiVisibilityExporter.getUncodedTraces(), [trace])
    assertObjectContains(agentProxyCiVisibilityExporter._coverageBuffer, [coverage])

    agentProxyCiVisibilityExporter.export = sinon.spy()
    agentProxyCiVisibilityExporter.exportCoverage = sinon.spy()

    await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise

    const uncodedTraces = agentProxyCiVisibilityExporter.getUncodedTraces()
    assert.ok(!uncodedTraces.includes(trace), `Got: ${inspect(uncodedTraces)}`)
    assert.ok(
      !(agentProxyCiVisibilityExporter._coverageBuffer).includes(coverage),
      `Got: ${inspect(agentProxyCiVisibilityExporter._coverageBuffer)}`
    )
    // old traces and coverages are exported at once
    sinon.assert.calledWith(agentProxyCiVisibilityExporter.export, trace)
    sinon.assert.calledWith(agentProxyCiVisibilityExporter.exportCoverage, coverage)
  })

  describe('agent is evp compatible', () => {
    beforeEach(() => {
      nock(url)
        .get('/info')
        .delay(queryDelay)
        .reply(200, JSON.stringify({
          endpoints: [
            '/evp_proxy/v2/',
            '/debugger/v1/input',
          ],
        }))
    })

    it('should initialise AgentlessWriter and CoverageWriter', async () => {
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ url, tags })
      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
      assert.ok(agentProxyCiVisibilityExporter._writer instanceof AgentlessWriter)
      assert.ok(agentProxyCiVisibilityExporter._coverageWriter instanceof CoverageWriter)
    })

    it('should process test suite level visibility spans', async () => {
      const mockWriter = {
        append: sinon.spy(),
        flush: sinon.spy(),
      }
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ url, tags })
      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
      agentProxyCiVisibilityExporter._writer = mockWriter
      const testSuiteTrace = [{ type: 'test_suite_end' }]
      const testSessionTrace = [{ type: 'test_session_end' }]
      agentProxyCiVisibilityExporter.export(testSuiteTrace)
      agentProxyCiVisibilityExporter.export(testSessionTrace)
      sinon.assert.calledWith(mockWriter.append, testSuiteTrace)
      sinon.assert.calledWith(mockWriter.append, testSessionTrace)
    })

    it('should process coverages', async () => {
      const mockWriter = {
        append: sinon.spy(),
        flush: sinon.spy(),
      }
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ url, tags })
      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
      agentProxyCiVisibilityExporter._coverageWriter = mockWriter
      const coverage = {
        traceId: '1',
        spanId: '1',
        files: [],
      }
      agentProxyCiVisibilityExporter._libraryConfig = { isCodeCoverageEnabled: true }
      agentProxyCiVisibilityExporter.exportCoverage(coverage)
      sinon.assert.calledWith(mockWriter.append, { spanId: '1', traceId: '1', files: [] })
    })

    context('if isTestDynamicInstrumentationEnabled is set', () => {
      it('should initialise DynamicInstrumentationLogsWriter', async () => {
        const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({
          url,
          tags,
          testOptimization: { DD_TEST_FAILED_TEST_REPLAY_ENABLED: true },
        })
        await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
        assert.ok(agentProxyCiVisibilityExporter._logsWriter instanceof DynamicInstrumentationLogsWriter)
      })

      it('should process logs', async () => {
        const mockWriter = {
          append: sinon.spy(),
          flush: sinon.spy(),
        }
        const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({
          url,
          tags,
          testOptimization: { DD_TEST_FAILED_TEST_REPLAY_ENABLED: true },
        })
        await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
        agentProxyCiVisibilityExporter._logsWriter = mockWriter
        const log = { message: 'hello' }
        agentProxyCiVisibilityExporter.exportDiLogs({}, log)
        sinon.assert.calledWith(mockWriter.append, sinon.match(log))
      })
    })
  })

  describe('agent is not evp compatible', () => {
    beforeEach(() => {
      nock(url)
        .get('/info')
        .delay(queryDelay)
        .reply(200, JSON.stringify({
          endpoints: ['/v0.4/traces'],
        }))
    })

    it('should initialise AgentWriter', async () => {
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ url, tags })
      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
      assert.ok(agentProxyCiVisibilityExporter._writer instanceof AgentWriter)
      assert.strictEqual(agentProxyCiVisibilityExporter._coverageWriter, undefined)
    })

    it('should not process test suite level visibility spans', async () => {
      const mockWriter = {
        append: sinon.spy(),
        flush: sinon.spy(),
      }
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ url, tags })
      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
      agentProxyCiVisibilityExporter._writer = mockWriter
      const testSuiteTrace = [{ type: 'test_suite_end' }]
      const testSessionTrace = [{ type: 'test_session_end' }]
      agentProxyCiVisibilityExporter.export(testSuiteTrace)
      agentProxyCiVisibilityExporter.export(testSessionTrace)
      sinon.assert.notCalled(mockWriter.append)
    })

    it('should not process coverages', async () => {
      const mockWriter = {
        append: sinon.spy(),
        flush: sinon.spy(),
      }
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ url, tags })
      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
      agentProxyCiVisibilityExporter._writer = mockWriter
      agentProxyCiVisibilityExporter._coverageWriter = mockWriter
      const testSuiteTrace = [{ type: 'test_suite_end' }]
      const testSessionTrace = [{ type: 'test_session_end' }]
      agentProxyCiVisibilityExporter.export(testSuiteTrace)
      agentProxyCiVisibilityExporter.export(testSessionTrace)
      agentProxyCiVisibilityExporter.exportCoverage({
        traceId: '1',
        spanId: '1',
        files: [],
      })
      sinon.assert.notCalled(mockWriter.append)
    })

    context('if isTestDynamicInstrumentationEnabled is set', () => {
      it('should not initialise DynamicInstrumentationLogsWriter', async () => {
        const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({
          url,
          tags,
          testOptimization: { DD_TEST_FAILED_TEST_REPLAY_ENABLED: true },
        })
        await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
        assert.strictEqual(agentProxyCiVisibilityExporter._logsWriter, undefined)
      })

      it('should not process logs', async () => {
        const mockWriter = {
          append: sinon.spy(),
          flush: sinon.spy(),
        }
        const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({
          url,
          tags,
          testOptimization: { DD_TEST_FAILED_TEST_REPLAY_ENABLED: true },
        })
        await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
        agentProxyCiVisibilityExporter._logsWriter = mockWriter
        const log = { message: 'hello' }
        agentProxyCiVisibilityExporter.exportDiLogs({}, log)
        sinon.assert.notCalled(mockWriter.append)
      })
    })
  })

  describe('export', () => {
    it('should flush after the flush interval if a trace has been exported', async () => {
      const mockWriter = {
        append: sinon.spy(),
        flush: sinon.spy(),
      }

      nock(url)
        .get('/info')
        .delay(queryDelay)
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2/'],
        }))
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ url, flushInterval, tags })
      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise

      agentProxyCiVisibilityExporter._writer = mockWriter
      agentProxyCiVisibilityExporter._coverageWriter = mockWriter
      const trace = [{ span_id: '1234' }]
      agentProxyCiVisibilityExporter.export(trace)
      sinon.assert.calledWith(mockWriter.append, trace)
      await new Promise(resolve => setTimeout(resolve, flushInterval))
      sinon.assert.called(mockWriter.flush)
    })

    it('should flush after the flush interval if a coverage has been exported', async () => {
      const mockWriter = {
        append: sinon.spy(),
        flush: sinon.spy(),
      }

      nock(url)
        .get('/info')
        .delay(queryDelay)
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2/'],
        }))

      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ url, flushInterval, tags })
      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise

      agentProxyCiVisibilityExporter._writer = mockWriter
      agentProxyCiVisibilityExporter._coverageWriter = mockWriter

      const coverage = {
        traceId: '1',
        spanId: '1',
        files: [],
      }
      agentProxyCiVisibilityExporter._libraryConfig = { isCodeCoverageEnabled: true }
      agentProxyCiVisibilityExporter.exportCoverage(coverage)
      sinon.assert.calledWith(mockWriter.append, { traceId: '1', spanId: '1', files: [] })
      await new Promise(resolve => setTimeout(resolve, flushInterval))
      sinon.assert.called(mockWriter.flush)
    })
  })

  describe('setUrl', () => {
    it('should set the URL on self and writers', async () => {
      const mockWriter = {
        setUrl: sinon.spy(),
      }
      const mockCoverageWriter = {
        setUrl: sinon.spy(),
      }
      nock(url)
        .get('/info')
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2/'],
        }))
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ url, tags })
      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
      agentProxyCiVisibilityExporter._writer = mockWriter
      agentProxyCiVisibilityExporter._coverageWriter = mockCoverageWriter

      const newUrl = 'http://example2.com'
      const newCoverageUrl = 'http://example3.com'
      agentProxyCiVisibilityExporter.setUrl(newUrl, newCoverageUrl)
      const urlObj = new URL(newUrl)
      const coverageUrlObj = new URL(newCoverageUrl)

      assert.deepStrictEqual(agentProxyCiVisibilityExporter._url, urlObj)
      assert.deepStrictEqual(agentProxyCiVisibilityExporter._coverageUrl, coverageUrlObj)
      sinon.assert.calledWith(mockWriter.setUrl, urlObj)
      sinon.assert.calledWith(mockCoverageWriter.setUrl, coverageUrlObj)
    })
  })

  describe('_isGzipCompatible', () => {
    it('should set _isGzipCompatible to true if the newest version is v4 or newer', async () => {
      const scope = nock(url)
        .get('/info')
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2', '/evp_proxy/v3', '/evp_proxy/v4/', '/evp_proxy/v5'],
        }))

      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ url, tags })

      assert.notStrictEqual(agentProxyCiVisibilityExporter, null)

      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise

      assert.strictEqual(agentProxyCiVisibilityExporter._isGzipCompatible, true)
      assert.strictEqual(scope.isDone(), true)
    })

    it('should set _isGzipCompatible to false if the newest version is v3 or older', async () => {
      const scope = nock(url)
        .get('/info')
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2', '/evp_proxy/v3'],
        }))

      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ url, tags })

      assert.notStrictEqual(agentProxyCiVisibilityExporter, null)

      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise

      assert.strictEqual(agentProxyCiVisibilityExporter._isGzipCompatible, false)
      assert.strictEqual(scope.isDone(), true)
    })
  })

  describe('evpProxyPrefix', () => {
    it('should set evpProxyPrefix to v2 if the newest version is v3', async () => {
      const scope = nock(url)
        .get('/info')
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2', '/evp_proxy/v3'],
        }))

      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ url, tags })

      assert.notStrictEqual(agentProxyCiVisibilityExporter, null)

      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise

      assert.strictEqual(agentProxyCiVisibilityExporter.evpProxyPrefix, '/evp_proxy/v2')
      assert.strictEqual(scope.isDone(), true)
    })

    it('should set evpProxyPrefix to v4 if the newest version is v4', async () => {
      const scope = nock(url)
        .get('/info')
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2', '/evp_proxy/v3', '/evp_proxy/v4/'],
        }))

      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ url, tags })

      assert.notStrictEqual(agentProxyCiVisibilityExporter, null)

      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise

      assert.strictEqual(agentProxyCiVisibilityExporter.evpProxyPrefix, '/evp_proxy/v4')
      assert.strictEqual(scope.isDone(), true)
    })
  })
})
