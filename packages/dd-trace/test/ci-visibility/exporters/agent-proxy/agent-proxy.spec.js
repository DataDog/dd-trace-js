'use strict'
const nock = require('nock')

const AgentProxyCiVisibilityExporter = require('../../../../src/ci-visibility/exporters/agent-proxy')
const AgentlessWriter = require('../../../../src/ci-visibility/exporters/agentless/writer')
const CoverageWriter = require('../../../../src/ci-visibility/exporters/agentless/coverage-writer')
const AgentWriter = require('../../../../src/exporters/agent/writer')

describe('AgentProxyCiVisibilityExporter', () => {
  const flushInterval = 50
  const port = 8126
  const queryDelay = 50
  const tags = {}

  it('should query /info right when it is instantiated', (done) => {
    const scope = nock('http://localhost:8126')
      .get('/info')
      .reply(200, JSON.stringify({
        endpoints: ['/evp_proxy/v2']
      }))

    const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })

    expect(agentProxyCiVisibilityExporter).not.to.be.null
    expect(scope.isDone()).to.be.true
    done()
  })

  it('should store traces and coverages as is until the query to /info is resolved', async () => {
    nock('http://localhost:8126')
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
      nock('http://localhost:8126')
        .get('/info')
        .delay(queryDelay)
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2/']
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
      agentProxyCiVisibilityExporter._itrConfig = { isCodeCoverageEnabled: true }
      agentProxyCiVisibilityExporter.exportCoverage(coverage)
      expect(mockWriter.append).to.have.been.calledWith({ spanId: '1', traceId: '1', files: [] })
    })
  })

  describe('agent is not evp compatible', () => {
    beforeEach(() => {
      nock('http://localhost:8126')
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
  })

  describe('export', () => {
    it('should flush after the flush interval if a trace has been exported', async () => {
      const mockWriter = {
        append: sinon.spy(),
        flush: sinon.spy()
      }

      nock('http://localhost:8126')
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

      nock('http://localhost:8126')
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
      agentProxyCiVisibilityExporter._itrConfig = { isCodeCoverageEnabled: true }
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
      nock('http://localhost:8126')
        .get('/info')
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2/']
        }))
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })
      agentProxyCiVisibilityExporter._writer = mockWriter
      agentProxyCiVisibilityExporter._coverageWriter = mockCoverageWriter
      agentProxyCiVisibilityExporter.setUrl('http://example2.com')
      const url = new URL('http://example2.com')
      expect(agentProxyCiVisibilityExporter._url).to.deep.equal(url)
      expect(mockWriter.setUrl).to.have.been.calledWith(url)
      expect(mockCoverageWriter.setUrl).to.have.been.calledWith(url)
    })
  })
})
