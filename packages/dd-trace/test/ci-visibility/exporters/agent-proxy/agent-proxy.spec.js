'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, context } = require('tap').mocha
const sinon = require('sinon')
const nock = require('nock')

require('../../../../../dd-trace/test/setup/core')

const AgentProxyCiVisibilityExporter = require('../../../../src/ci-visibility/exporters/agent-proxy')
const AgentlessWriter = require('../../../../src/ci-visibility/exporters/agentless/writer')
const DynamicInstrumentationLogsWriter = require('../../../../src/ci-visibility/exporters/agentless/di-logs-writer')
const CoverageWriter = require('../../../../src/ci-visibility/exporters/agentless/coverage-writer')
const AgentWriter = require('../../../../src/exporters/agent/writer')

describe('AgentProxyCiVisibilityExporter', () => {
  const flushInterval = 50
  const port = 8126
  const queryDelay = 50
  const tags = {}

  it('should query /info right when it is instantiated', async () => {
    const scope = nock('http://127.0.0.1:8126')
      .get('/info')
      .reply(200, JSON.stringify({
        endpoints: ['/evp_proxy/v2']
      }))

    const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })

    expect(agentProxyCiVisibilityExporter).not.to.be.null
    await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
    expect(scope.isDone()).to.be.true
  })

  it('should store traces and coverages as is until the query to /info is resolved', async () => {
    nock('http://127.0.0.1:8126')
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

    expect(agentProxyCiVisibilityExporter.getUncodedTraces()).to.include(trace)
    expect(agentProxyCiVisibilityExporter._coverageBuffer).to.include(coverage)

    agentProxyCiVisibilityExporter.export = sinon.spy()
    agentProxyCiVisibilityExporter.exportCoverage = sinon.spy()

    await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise

    expect(agentProxyCiVisibilityExporter.getUncodedTraces()).not.to.include(trace)
    expect(agentProxyCiVisibilityExporter._coverageBuffer).not.to.include(coverage)
    // old traces and coverages are exported at once
    expect(agentProxyCiVisibilityExporter.export).to.have.been.calledWith(trace)
    expect(agentProxyCiVisibilityExporter.exportCoverage).to.have.been.calledWith(coverage)
  })

  describe('agent is evp compatible', () => {
    beforeEach(() => {
      nock('http://127.0.0.1:8126')
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
      expect(agentProxyCiVisibilityExporter._writer).to.be.instanceOf(AgentlessWriter)
      expect(agentProxyCiVisibilityExporter._coverageWriter).to.be.instanceOf(CoverageWriter)
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
      expect(mockWriter.append).to.have.been.calledWith(testSuiteTrace)
      expect(mockWriter.append).to.have.been.calledWith(testSessionTrace)
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
      expect(mockWriter.append).to.have.been.calledWith({ spanId: '1', traceId: '1', files: [] })
    })

    context('if isTestDynamicInstrumentationEnabled is set', () => {
      it('should initialise DynamicInstrumentationLogsWriter', async () => {
        const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({
          port,
          tags,
          isTestDynamicInstrumentationEnabled: true
        })
        await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
        expect(agentProxyCiVisibilityExporter._logsWriter).to.be.instanceOf(DynamicInstrumentationLogsWriter)
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
        expect(mockWriter.append).to.have.been.calledWith(sinon.match(log))
      })
    })
  })

  describe('agent is not evp compatible', () => {
    beforeEach(() => {
      nock('http://127.0.0.1:8126')
        .get('/info')
        .delay(queryDelay)
        .reply(200, JSON.stringify({
          endpoints: ['/v0.4/traces']
        }))
    })

    it('should initialise AgentWriter', async () => {
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })
      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
      expect(agentProxyCiVisibilityExporter._writer).to.be.instanceOf(AgentWriter)
      expect(agentProxyCiVisibilityExporter._coverageWriter).to.be.undefined
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
      expect(mockWriter.append).not.to.have.been.called
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
      expect(mockWriter.append).not.to.have.been.called
    })

    context('if isTestDynamicInstrumentationEnabled is set', () => {
      it('should not initialise DynamicInstrumentationLogsWriter', async () => {
        const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({
          port,
          tags,
          isTestDynamicInstrumentationEnabled: true
        })
        await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
        expect(agentProxyCiVisibilityExporter._logsWriter).to.be.undefined
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
        expect(mockWriter.append).not.to.have.been.called
      })
    })
  })

  describe('export', () => {
    it('should flush after the flush interval if a trace has been exported', async () => {
      const mockWriter = {
        append: sinon.spy(),
        flush: sinon.spy()
      }

      nock('http://127.0.0.1:8126')
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
      expect(mockWriter.append).to.have.been.calledWith(trace)
      await new Promise(resolve => setTimeout(resolve, flushInterval))
      expect(mockWriter.flush).to.have.been.called
    })

    it('should flush after the flush interval if a coverage has been exported', async () => {
      const mockWriter = {
        append: sinon.spy(),
        flush: sinon.spy()
      }

      nock('http://127.0.0.1:8126')
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
      expect(mockWriter.append).to.have.been.calledWith({ traceId: '1', spanId: '1', files: [] })
      await new Promise(resolve => setTimeout(resolve, flushInterval))
      expect(mockWriter.flush).to.have.been.called
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
      nock('http://127.0.0.1:8126')
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
      const url = new URL(newUrl)
      const coverageUrl = new URL(newCoverageUrl)

      expect(agentProxyCiVisibilityExporter._url).to.deep.equal(url)
      expect(agentProxyCiVisibilityExporter._coverageUrl).to.deep.equal(coverageUrl)
      expect(mockWriter.setUrl).to.have.been.calledWith(url)
      expect(mockCoverageWriter.setUrl).to.have.been.calledWith(coverageUrl)
    })
  })

  describe('_isGzipCompatible', () => {
    it('should set _isGzipCompatible to true if the newest version is v4 or newer', async () => {
      const scope = nock('http://127.0.0.1:8126')
        .get('/info')
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2', '/evp_proxy/v3', '/evp_proxy/v4/', '/evp_proxy/v5']
        }))

      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })

      expect(agentProxyCiVisibilityExporter).not.to.be.null

      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise

      expect(agentProxyCiVisibilityExporter._isGzipCompatible).to.be.true
      expect(scope.isDone()).to.be.true
    })

    it('should set _isGzipCompatible to false if the newest version is v3 or older', async () => {
      const scope = nock('http://127.0.0.1:8126')
        .get('/info')
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2', '/evp_proxy/v3']
        }))

      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })

      expect(agentProxyCiVisibilityExporter).not.to.be.null

      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise

      expect(agentProxyCiVisibilityExporter._isGzipCompatible).to.be.false
      expect(scope.isDone()).to.be.true
    })
  })

  describe('evpProxyPrefix', () => {
    it('should set evpProxyPrefix to v2 if the newest version is v3', async () => {
      const scope = nock('http://127.0.0.1:8126')
        .get('/info')
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2', '/evp_proxy/v3']
        }))

      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })

      expect(agentProxyCiVisibilityExporter).not.to.be.null

      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise

      expect(agentProxyCiVisibilityExporter.evpProxyPrefix).to.equal('/evp_proxy/v2')
      expect(scope.isDone()).to.be.true
    })

    it('should set evpProxyPrefix to v4 if the newest version is v4', async () => {
      const scope = nock('http://127.0.0.1:8126')
        .get('/info')
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2', '/evp_proxy/v3', '/evp_proxy/v4/']
        }))

      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })

      expect(agentProxyCiVisibilityExporter).not.to.be.null

      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise

      expect(agentProxyCiVisibilityExporter.evpProxyPrefix).to.equal('/evp_proxy/v4')
      expect(scope.isDone()).to.be.true
    })
  })
})
