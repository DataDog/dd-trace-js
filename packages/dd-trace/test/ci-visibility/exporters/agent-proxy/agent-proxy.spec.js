'use strict'

const t = require('tap')
require('../../../../../dd-trace/test/setup/core')

const nock = require('nock')

const AgentProxyCiVisibilityExporter = require('../../../../src/ci-visibility/exporters/agent-proxy')
const AgentlessWriter = require('../../../../src/ci-visibility/exporters/agentless/writer')
const DynamicInstrumentationLogsWriter = require('../../../../src/ci-visibility/exporters/agentless/di-logs-writer')
const CoverageWriter = require('../../../../src/ci-visibility/exporters/agentless/coverage-writer')
const AgentWriter = require('../../../../src/exporters/agent/writer')

t.test('AgentProxyCiVisibilityExporter', t => {
  const flushInterval = 50
  const port = 8126
  const queryDelay = 50
  const tags = {}

  t.test('should query /info right when it is instantiated', (t) => {
    const scope = nock('http://localhost:8126')
      .get('/info')
      .reply(200, JSON.stringify({
        endpoints: ['/evp_proxy/v2']
      }))

    const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })

    expect(agentProxyCiVisibilityExporter).not.to.be.null
    expect(scope.isDone()).to.be.true
    t.end()
  })

  t.test('should store traces and coverages as is until the query to /info is resolved', async t => {
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
    t.end()
  })

  t.test('agent is evp compatible', t => {
    t.beforeEach(() => {
      nock('http://localhost:8126')
        .get('/info')
        .delay(queryDelay)
        .reply(200, JSON.stringify({
          endpoints: [
            '/evp_proxy/v2/',
            '/debugger/v1/input'
          ]
        }))
    })

    t.test('should initialise AgentlessWriter and CoverageWriter', async t => {
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })
      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
      expect(agentProxyCiVisibilityExporter._writer).to.be.instanceOf(AgentlessWriter)
      expect(agentProxyCiVisibilityExporter._coverageWriter).to.be.instanceOf(CoverageWriter)
      t.end()
    })

    t.test('should process test suite level visibility spans', async t => {
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
      t.end()
    })

    t.test('should process coverages', async t => {
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
      t.end()
    })

    context('if isTestDynamicInstrumentationEnabled is set', () => {
      t.test('should initialise DynamicInstrumentationLogsWriter', async t => {
        const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({
          port,
          tags,
          isTestDynamicInstrumentationEnabled: true
        })
        await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
        expect(agentProxyCiVisibilityExporter._logsWriter).to.be.instanceOf(DynamicInstrumentationLogsWriter)
        t.end()
      })

      t.test('should process logs', async t => {
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
        t.end()
      })
    })
    t.end()
  })

  t.test('agent is not evp compatible', t => {
    t.beforeEach(() => {
      nock('http://localhost:8126')
        .get('/info')
        .delay(queryDelay)
        .reply(200, JSON.stringify({
          endpoints: ['/v0.4/traces']
        }))
    })

    t.test('should initialise AgentWriter', async t => {
      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })
      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
      expect(agentProxyCiVisibilityExporter._writer).to.be.instanceOf(AgentWriter)
      expect(agentProxyCiVisibilityExporter._coverageWriter).to.be.undefined
      t.end()
    })

    t.test('should not process test suite level visibility spans', async t => {
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
      t.end()
    })

    t.test('should not process coverages', async t => {
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
      t.end()
    })

    context('if isTestDynamicInstrumentationEnabled is set', () => {
      t.test('should not initialise DynamicInstrumentationLogsWriter', async t => {
        const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({
          port,
          tags,
          isTestDynamicInstrumentationEnabled: true
        })
        await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
        expect(agentProxyCiVisibilityExporter._logsWriter).to.be.undefined
        t.end()
      })

      t.test('should not process logs', async t => {
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
        t.end()
      })
    })
    t.end()
  })

  t.test('export', t => {
    t.test('should flush after the flush interval if a trace has been exported', async t => {
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
      t.end()
    })

    t.test('should flush after the flush interval if a coverage has been exported', async t => {
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
      agentProxyCiVisibilityExporter._libraryConfig = { isCodeCoverageEnabled: true }
      agentProxyCiVisibilityExporter.exportCoverage(coverage)
      expect(mockWriter.append).to.have.been.calledWith({ traceId: '1', spanId: '1', files: [] })
      await new Promise(resolve => setTimeout(resolve, flushInterval))
      expect(mockWriter.flush).to.have.been.called
      t.end()
    })
    t.end()
  })

  t.test('setUrl', t => {
    t.test('should set the URL on self and writers', t => {
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

      const newUrl = 'http://example2.com'
      const newCoverageUrl = 'http://example3.com'
      agentProxyCiVisibilityExporter.setUrl(newUrl, newCoverageUrl)
      const url = new URL(newUrl)
      const coverageUrl = new URL(newCoverageUrl)

      expect(agentProxyCiVisibilityExporter._url).to.deep.equal(url)
      expect(agentProxyCiVisibilityExporter._coverageUrl).to.deep.equal(coverageUrl)
      expect(mockWriter.setUrl).to.have.been.calledWith(url)
      expect(mockCoverageWriter.setUrl).to.have.been.calledWith(coverageUrl)
      t.end()
    })
    t.end()
  })

  t.test('_isGzipCompatible', t => {
    t.test('should set _isGzipCompatible to true if the newest version is v4 or newer', async t => {
      const scope = nock('http://localhost:8126')
        .get('/info')
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2', '/evp_proxy/v3', '/evp_proxy/v4/', '/evp_proxy/v5']
        }))

      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })

      expect(agentProxyCiVisibilityExporter).not.to.be.null

      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise

      expect(agentProxyCiVisibilityExporter._isGzipCompatible).to.be.true
      expect(scope.isDone()).to.be.true
      t.end()
    })

    t.test('should set _isGzipCompatible to false if the newest version is v3 or older', async t => {
      const scope = nock('http://localhost:8126')
        .get('/info')
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2', '/evp_proxy/v3']
        }))

      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })

      expect(agentProxyCiVisibilityExporter).not.to.be.null

      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise

      expect(agentProxyCiVisibilityExporter._isGzipCompatible).to.be.false
      expect(scope.isDone()).to.be.true
      t.end()
    })
    t.end()
  })

  t.test('evpProxyPrefix', t => {
    t.test('should set evpProxyPrefix to v2 if the newest version is v3', async t => {
      const scope = nock('http://localhost:8126')
        .get('/info')
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2', '/evp_proxy/v3']
        }))

      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })

      expect(agentProxyCiVisibilityExporter).not.to.be.null

      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise

      expect(agentProxyCiVisibilityExporter.evpProxyPrefix).to.equal('/evp_proxy/v2')
      expect(scope.isDone()).to.be.true
      t.end()
    })

    t.test('should set evpProxyPrefix to v4 if the newest version is v4', async t => {
      const scope = nock('http://localhost:8126')
        .get('/info')
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2', '/evp_proxy/v3', '/evp_proxy/v4/']
        }))

      const agentProxyCiVisibilityExporter = new AgentProxyCiVisibilityExporter({ port, tags })

      expect(agentProxyCiVisibilityExporter).not.to.be.null

      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise

      expect(agentProxyCiVisibilityExporter.evpProxyPrefix).to.equal('/evp_proxy/v4')
      expect(scope.isDone()).to.be.true
      t.end()
    })
    t.end()
  })
  t.end()
})
