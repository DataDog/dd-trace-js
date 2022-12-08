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

  it('should store traces and coverages as is until the query to /info is resolved', (done) => {
    nock('http://localhost:8126')
      .get('/info')
      .delay(queryDelay)
      .reply(200, JSON.stringify({
        endpoints: ['/evp_proxy/v2/']
      }))
    const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })

    const trace = [{ span_id: '1234' }]
    const coverage = [{ span: {}, coverageFiles: [] }]
    agentProxyCiVisibilityExporter.export(trace)
    agentProxyCiVisibilityExporter.exportCoverage(coverage)

    expect(agentProxyCiVisibilityExporter.getUncodedTraces()).to.include(trace)
    expect(agentProxyCiVisibilityExporter._coverageBuffer).to.include(coverage)

    agentProxyCiVisibilityExporter.export = sinon.spy()
    agentProxyCiVisibilityExporter.exportCoverage = sinon.spy()

    setTimeout(() => {
      expect(agentProxyCiVisibilityExporter.getUncodedTraces()).not.to.include(trace)
      expect(agentProxyCiVisibilityExporter._coverageBuffer).not.to.include(coverage)
      // old traces and coverages are exported at once
      expect(agentProxyCiVisibilityExporter.export).to.have.been.calledWith(trace)
      expect(agentProxyCiVisibilityExporter.exportCoverage).to.have.been.calledWith(coverage)
      done()
    }, queryDelay + 20)
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
    it('should initialise AgentlessWriter and CoverageWriter', (done) => {
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })
      setTimeout(() => {
        expect(agentProxyCiVisibilityExporter._writer).to.be.instanceOf(AgentlessWriter)
        expect(agentProxyCiVisibilityExporter._coverageWriter).to.be.instanceOf(CoverageWriter)
        done()
      }, queryDelay + 20)
    })
    it('should process test suite level visibility spans', (done) => {
      const mockWriter = {
        append: sinon.spy(),
        flush: sinon.spy()
      }
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })
      setTimeout(() => {
        agentProxyCiVisibilityExporter._writer = mockWriter
        const testSuiteTrace = [{ type: 'test_suite_end' }]
        const testSessionTrace = [{ type: 'test_session_end' }]
        agentProxyCiVisibilityExporter.export(testSuiteTrace)
        agentProxyCiVisibilityExporter.export(testSessionTrace)
        expect(mockWriter.append).to.have.been.calledWith(testSuiteTrace)
        expect(mockWriter.append).to.have.been.calledWith(testSessionTrace)
        done()
      }, queryDelay + 20)
    })
    it('should process coverages', (done) => {
      const mockWriter = {
        append: sinon.spy(),
        flush: sinon.spy()
      }
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })
      setTimeout(() => {
        agentProxyCiVisibilityExporter._coverageWriter = mockWriter
        const coverage = { span: { context: () => ({ _traceId: '1', _spanId: '1' }) }, coverageFiles: [] }
        agentProxyCiVisibilityExporter.exportCoverage(coverage)
        expect(mockWriter.append).to.have.been.calledWith({ spanId: '1', traceId: '1', files: [] })
        done()
      }, queryDelay + 20)
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
    it('should initialise AgentWriter', (done) => {
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })
      setTimeout(() => {
        expect(agentProxyCiVisibilityExporter._writer).to.be.instanceOf(AgentWriter)
        expect(agentProxyCiVisibilityExporter._coverageWriter).to.be.undefined
        done()
      }, queryDelay + 20)
    })
    it('should not process test suite level visibility spans', (done) => {
      const mockWriter = {
        append: sinon.spy(),
        flush: sinon.spy()
      }
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })
      setTimeout(() => {
        agentProxyCiVisibilityExporter._writer = mockWriter
        const testSuiteTrace = [{ type: 'test_suite_end' }]
        const testSessionTrace = [{ type: 'test_session_end' }]
        agentProxyCiVisibilityExporter.export(testSuiteTrace)
        agentProxyCiVisibilityExporter.export(testSessionTrace)
        expect(mockWriter.append).not.to.have.been.called
        done()
      }, queryDelay + 20)
    })

    it('should not process coverages', (done) => {
      const mockWriter = {
        append: sinon.spy(),
        flush: sinon.spy()
      }
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })
      setTimeout(() => {
        agentProxyCiVisibilityExporter._writer = mockWriter
        agentProxyCiVisibilityExporter._coverageWriter = mockWriter
        const testSuiteTrace = [{ type: 'test_suite_end' }]
        const testSessionTrace = [{ type: 'test_session_end' }]
        agentProxyCiVisibilityExporter.export(testSuiteTrace)
        agentProxyCiVisibilityExporter.export(testSessionTrace)
        agentProxyCiVisibilityExporter.exportCoverage({ span: {}, coverageFiles: [] })
        expect(mockWriter.append).not.to.have.been.called
        done()
      }, queryDelay + 20)
    })
  })

  describe('export', () => {
    it('should flush after the flush interval if a trace has been exported', (done) => {
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

      setTimeout(() => {
        agentProxyCiVisibilityExporter._writer = mockWriter
        agentProxyCiVisibilityExporter._coverageWriter = mockWriter
        const trace = [{ span_id: '1234' }]
        agentProxyCiVisibilityExporter.export(trace)
        expect(mockWriter.append).to.have.been.calledWith(trace)
        setTimeout(() => {
          expect(mockWriter.flush).to.have.been.called
          done()
        }, flushInterval)
      }, queryDelay + 20)
    })

    it('should flush after the flush interval if a coverage has been exported', (done) => {
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

      setTimeout(() => {
        agentProxyCiVisibilityExporter._writer = mockWriter
        agentProxyCiVisibilityExporter._coverageWriter = mockWriter

        const coverage = { span: { context: () => ({ _traceId: '1', _spanId: '1' }) }, coverageFiles: [] }
        agentProxyCiVisibilityExporter.exportCoverage(coverage)
        expect(mockWriter.append).to.have.been.calledWith({ traceId: '1', spanId: '1', files: [] })
        setTimeout(() => {
          expect(mockWriter.flush).to.have.been.called
          done()
        }, flushInterval)
      }, queryDelay + 20)
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
