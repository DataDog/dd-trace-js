'use strict'
const nock = require('nock')

const AgentProxyCiVisibilityExporter = require('../../../../src/ci-visibility/exporters/agent-proxy')
const AgentlessWriter = require('../../../../src/ci-visibility/exporters/agentless/writer')
const CoverageWriter = require('../../../../src/ci-visibility/exporters/agentless/coverage-writer')
const AgentWriter = require('../../../../src/exporters/agent/writer')

describe('AgentProxyCiVisibilityExporter', () => {
  const flushInterval = 100
  const port = 8126

  it('should query /info right when it is instantiated', (done) => {
    const scope = nock('http://localhost:8126')
      .get('/info')
      .reply(200, JSON.stringify({
        endpoints: ['/evp_proxy/v2']
      }))

    const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port })

    expect(agentProxyCiVisibilityExporter).not.to.be.null
    expect(scope.isDone()).to.be.true
    done()
  })

  it('should store traces and coverages as is until the query to /info is resolved', () => {
    const queryDelay = 1000
    nock('http://localhost:8126')
      .get('/info')
      .delay(queryDelay)
      .reply(200, JSON.stringify({
        endpoints: ['/evp_proxy/v2/']
      }))
    const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port })

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
    }, queryDelay + 100)
  })

  it('should initialise agentless and coverage writers if the agent is evp proxy compatible', () => {
    const queryDelay = 1000
    nock('http://localhost:8126')
      .get('/info')
      .delay(queryDelay)
      .reply(200, JSON.stringify({
        endpoints: ['/evp_proxy/v2/']
      }))
    const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port })
    setTimeout(() => {
      expect(agentProxyCiVisibilityExporter._writer).to.be.instanceOf(AgentlessWriter)
      expect(agentProxyCiVisibilityExporter._coverageWriter).to.be.instanceOf(CoverageWriter)
    }, queryDelay + 100)
  })

  it('should initialise the agent writer if the agent is not evp proxy compatible', () => {
    const queryDelay = 1000
    nock('http://localhost:8126')
      .get('/info')
      .delay(queryDelay)
      .reply(200, JSON.stringify({
        endpoints: ['/v0.4/traces']
      }))
    const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port })
    setTimeout(() => {
      expect(agentProxyCiVisibilityExporter._writer).to.be.instanceOf(AgentWriter)
      expect(agentProxyCiVisibilityExporter._coverageWriter).to.be.null
    }, queryDelay + 100)
  })

  describe('export', () => {
    it('should flush after the flush interval if a trace has been exported', () => {
      const mockWriter = {
        append: sinon.spy(),
        flush: sinon.spy()
      }

      nock('http://localhost:8126')
        .get('/info')
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2/']
        }))
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, flushInterval })
      agentProxyCiVisibilityExporter._writer = mockWriter
      const trace = [{ span_id: '1234' }]
      agentProxyCiVisibilityExporter.export(trace)
      expect(mockWriter.append).to.have.been.calledWith(trace)
      setTimeout(() => {
        expect(mockWriter.flush).to.have.been.called()
      }, flushInterval)
    })

    it('should flush after the flush interval if a coverage has been exported', () => {
      const mockWriter = {
        append: sinon.spy(),
        flush: sinon.spy()
      }

      nock('http://localhost:8126')
        .get('/info')
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2/']
        }))

      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, flushInterval })
      agentProxyCiVisibilityExporter._coverageWriter = mockWriter

      const coverage = { span: { context: () => ({ _traceId: '1', _spanId: '1' }) }, coverageFiles: [] }
      agentProxyCiVisibilityExporter.exportCoverage(coverage)
      expect(mockWriter.append).to.have.been.calledWith({ traceId: '1', spanId: '1', files: [] })
      setTimeout(() => {
        expect(mockWriter.flush).to.have.been.called()
      }, flushInterval)
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
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port })
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
