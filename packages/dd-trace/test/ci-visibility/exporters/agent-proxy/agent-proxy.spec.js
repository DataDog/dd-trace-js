'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const context = describe
const sinon = require('sinon')
const nock = require('nock')

const { assertObjectContains } = require('../../../../../../integration-tests/helpers')
require('../../../../../dd-trace/test/setup/core')
const AgentProxyCiVisibilityExporter = require('../../../../src/ci-visibility/exporters/agent-proxy')
const AgentlessWriter = require('../../../../src/ci-visibility/exporters/agentless/writer')
const DynamicInstrumentationLogsWriter = require('../../../../src/ci-visibility/exporters/agentless/di-logs-writer')
const CoverageWriter = require('../../../../src/ci-visibility/exporters/agentless/coverage-writer')
const AgentWriter = require('../../../../src/exporters/agent/writer')
const { clearCache } = require('../../../../src/agent/info')

describe('AgentProxyCiVisibilityExporter', () => {
  beforeEach(() => {
    clearCache()
    nock.cleanAll()
  })

  const flushInterval = 50
  const port = 8126
  const url = `http://127.0.0.1:${port}`
  const queryDelay = 50
  const tags = {}

  it('should query /info right when it is instantiated', async () => {
    const scope = nock(url)
      .get('/info')
      .reply(200, JSON.stringify({
        endpoints: ['/evp_proxy/v2']
      }))

    const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })

    assert.notStrictEqual(agentProxyCiVisibilityExporter, null)
    await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
    assert.strictEqual(scope.isDone(), true)
  })

  it('should store traces and coverages as is until the query to /info is resolved', async () => {
    nock(url)
      .get('/info')
      .delay(queryDelay)
      .reply(200, JSON.stringify({
        endpoints: ['/evp_proxy/v2/']
      }))
    const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })

    const trace = [{ span_id: '1234' }]
    const coverage = {
      traceId: '1',
      spanId: '2',
      files: ['example.js']
    }
    agentProxyCiVisibilityExporter.export(trace)
    agentProxyCiVisibilityExporter.exportCoverage(coverage)

    assertObjectContains(agentProxyCiVisibilityExporter.getUncodedTraces(), [trace])
    assertObjectContains(agentProxyCiVisibilityExporter._coverageBuffer, [coverage])

    agentProxyCiVisibilityExporter.export = sinon.spy()
    agentProxyCiVisibilityExporter.exportCoverage = sinon.spy()

    await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise

    assert.ok(!(agentProxyCiVisibilityExporter.getUncodedTraces()).includes(trace))
    assert.ok(!(agentProxyCiVisibilityExporter._coverageBuffer).includes(coverage))
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
            '/debugger/v1/input'
          ]
        }))
    })

    it('should initialise AgentlessWriter and CoverageWriter', async () => {
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })
      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
      assert.ok(agentProxyCiVisibilityExporter._writer instanceof AgentlessWriter)
      assert.ok(agentProxyCiVisibilityExporter._coverageWriter instanceof CoverageWriter)
    })

    it('should process test suite level visibility spans', async () => {
      const mockWriter = {
        append: sinon.spy(),
        flush: sinon.spy()
      }
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })
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
        flush: sinon.spy()
      }
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })
      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
      agentProxyCiVisibilityExporter._coverageWriter = mockWriter
      const coverage = {
        traceId: '1',
        spanId: '1',
        files: []
      }
      agentProxyCiVisibilityExporter._libraryConfig = { isCodeCoverageEnabled: true }
      agentProxyCiVisibilityExporter.exportCoverage(coverage)
      sinon.assert.calledWith(mockWriter.append, { spanId: '1', traceId: '1', files: [] })
    })

    context('if isTestDynamicInstrumentationEnabled is set', () => {
      it('should initialise DynamicInstrumentationLogsWriter', async () => {
        const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({
          port,
          tags,
          isTestDynamicInstrumentationEnabled: true
        })
        await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
        assert.ok(agentProxyCiVisibilityExporter._logsWriter instanceof DynamicInstrumentationLogsWriter)
      })

      it('should process logs', async () => {
        const mockWriter = {
          append: sinon.spy(),
          flush: sinon.spy()
        }
        const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({
          port,
          tags,
          isTestDynamicInstrumentationEnabled: true
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
          endpoints: ['/v0.4/traces']
        }))
    })

    it('should initialise AgentWriter', async () => {
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })
      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
      assert.ok(agentProxyCiVisibilityExporter._writer instanceof AgentWriter)
      assert.strictEqual(agentProxyCiVisibilityExporter._coverageWriter, undefined)
    })

    it('should not process test suite level visibility spans', async () => {
      const mockWriter = {
        append: sinon.spy(),
        flush: sinon.spy()
      }
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })
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
        flush: sinon.spy()
      }
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })
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
        files: []
      })
      sinon.assert.notCalled(mockWriter.append)
    })

    context('if isTestDynamicInstrumentationEnabled is set', () => {
      it('should not initialise DynamicInstrumentationLogsWriter', async () => {
        const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({
          port,
          tags,
          isTestDynamicInstrumentationEnabled: true
        })
        await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
        assert.strictEqual(agentProxyCiVisibilityExporter._logsWriter, undefined)
      })

      it('should not process logs', async () => {
        const mockWriter = {
          append: sinon.spy(),
          flush: sinon.spy()
        }
        const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({
          port,
          tags,
          isTestDynamicInstrumentationEnabled: true
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
        flush: sinon.spy()
      }

      nock(url)
        .get('/info')
        .delay(queryDelay)
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2/']
        }))
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, flushInterval, tags })
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
        flush: sinon.spy()
      }

      nock(url)
        .get('/info')
        .delay(queryDelay)
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2/']
        }))

      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, flushInterval, tags })
      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise

      agentProxyCiVisibilityExporter._writer = mockWriter
      agentProxyCiVisibilityExporter._coverageWriter = mockWriter

      const coverage = {
        traceId: '1',
        spanId: '1',
        files: []
      }
      agentProxyCiVisibilityExporter._libraryConfig = { isCodeCoverageEnabled: true }
      agentProxyCiVisibilityExporter.exportCoverage(coverage)
      sinon.assert.calledWith(mockWriter.append, { traceId: '1', spanId: '1', files: [] })
      await new Promise(resolve => setTimeout(resolve, flushInterval))
      sinon.assert.called(mockWriter.flush)
    })
  })

  describe('setUrl', () => {
    it('should set the URL on self and writers', () => {
      const mockWriter = {
        setUrl: sinon.spy()
      }
      const mockCoverageWriter = {
        setUrl: sinon.spy()
      }
      nock(url)
        .get('/info')
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2/']
        }))
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })
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
          endpoints: ['/evp_proxy/v2', '/evp_proxy/v3', '/evp_proxy/v4/', '/evp_proxy/v5']
        }))

      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })

      assert.notStrictEqual(agentProxyCiVisibilityExporter, null)

      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise

      assert.strictEqual(agentProxyCiVisibilityExporter._isGzipCompatible, true)
      assert.strictEqual(scope.isDone(), true)
    })

    it('should set _isGzipCompatible to false if the newest version is v3 or older', async () => {
      const scope = nock(url)
        .get('/info')
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2', '/evp_proxy/v3']
        }))

      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })

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
          endpoints: ['/evp_proxy/v2', '/evp_proxy/v3']
        }))

      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })

      assert.notStrictEqual(agentProxyCiVisibilityExporter, null)

      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise

      assert.strictEqual(agentProxyCiVisibilityExporter.evpProxyPrefix, '/evp_proxy/v2')
      assert.strictEqual(scope.isDone(), true)
    })

    it('should set evpProxyPrefix to v4 if the newest version is v4', async () => {
      const scope = nock(url)
        .get('/info')
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2', '/evp_proxy/v3', '/evp_proxy/v4/']
        }))

      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })

      assert.notStrictEqual(agentProxyCiVisibilityExporter, null)

      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise

      assert.strictEqual(agentProxyCiVisibilityExporter.evpProxyPrefix, '/evp_proxy/v4')
      assert.strictEqual(scope.isDone(), true)
    })
  })
})
