'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach, before, after, context } = require('tap').mocha
const sinon = require('sinon')
const nock = require('nock')
const cp = require('node:child_process')

require('../../../../../dd-trace/test/setup/core')

const AgentlessCiVisibilityExporter = require('../../../../src/ci-visibility/exporters/agentless')
const DynamicInstrumentationLogsWriter = require('../../../../src/ci-visibility/exporters/agentless/di-logs-writer')

describe('CI Visibility Agentless Exporter', () => {
  const url = new URL('http://www.example.com')

  beforeEach(() => {
    // to make sure `isShallowRepository` in `git.js` returns false
    sinon.stub(cp, 'execFileSync').returns('false')
    nock.cleanAll()
  })

  afterEach(() => {
    sinon.restore()
  })

  before(() => {
    process.env.DD_API_KEY = '1'
  })

  after(() => {
    delete process.env.DD_API_KEY
  })

  it('can use CI Vis protocol right away', () => {
    const agentlessExporter = new AgentlessCiVisibilityExporter({ url, isGitUploadEnabled: true, tags: {} })
    expect(agentlessExporter.canReportSessionTraces()).to.be.true
  })

  describe('when ITR is enabled', () => {
    it('will request configuration to api.site by default', (done) => {
      const scope = nock('https://api.datadoge.c0m')
        .post('/api/v2/libraries/tests/services/setting')
        .reply(200, JSON.stringify({
          data: {
            attributes: {
              require_git: false,
              code_coverage: true,
              tests_skipping: true
            }
          }
        }))
      const agentlessExporter = new AgentlessCiVisibilityExporter({
        site: 'datadoge.c0m',
        isGitUploadEnabled: true,
        isIntelligentTestRunnerEnabled: true,
        tags: {}
      })
      agentlessExporter.getLibraryConfiguration({}, () => {
        expect(scope.isDone()).to.be.true
        expect(agentlessExporter.canReportCodeCoverage()).to.be.true
        expect(agentlessExporter.shouldRequestSkippableSuites()).to.be.true
        done()
      })
    })

    it('will request skippable to api.site by default', (done) => {
      const scope = nock('https://api.datadoge.c0m')
        .post('/api/v2/libraries/tests/services/setting')
        .reply(200, JSON.stringify({
          data: {
            attributes: {
              require_git: false,
              code_coverage: true,
              tests_skipping: true
            }
          }
        }))
        .post('/api/v2/ci/tests/skippable')
        .reply(200, JSON.stringify({
          data: []
        }))

      const agentlessExporter = new AgentlessCiVisibilityExporter({
        site: 'datadoge.c0m',
        isGitUploadEnabled: true,
        isIntelligentTestRunnerEnabled: true,
        tags: {}
      })
      agentlessExporter._resolveGit()
      agentlessExporter.getLibraryConfiguration({}, () => {
        agentlessExporter.getSkippableSuites({}, () => {
          expect(scope.isDone()).to.be.true
          done()
        })
      })
    })

    it('can request ITR configuration right away', (done) => {
      const scope = nock('http://www.example.com')
        .post('/api/v2/libraries/tests/services/setting')
        .reply(200, JSON.stringify({
          data: {
            attributes: {
              require_git: false,
              code_coverage: true,
              tests_skipping: true
            }
          }
        }))
      const agentlessExporter = new AgentlessCiVisibilityExporter({
        url, isGitUploadEnabled: true, isIntelligentTestRunnerEnabled: true, tags: {}
      })
      agentlessExporter.getLibraryConfiguration({}, () => {
        expect(scope.isDone()).to.be.true
        expect(agentlessExporter.canReportCodeCoverage()).to.be.true
        expect(agentlessExporter.shouldRequestSkippableSuites()).to.be.true
        done()
      })
    })

    it('can report code coverages if enabled by the API', (done) => {
      const scope = nock('http://www.example.com')
        .post('/api/v2/libraries/tests/services/setting')
        .reply(200, JSON.stringify({
          data: {
            attributes: {
              require_git: false,
              code_coverage: true,
              tests_skipping: true
            }
          }
        }))
      const agentlessExporter = new AgentlessCiVisibilityExporter({
        url, isGitUploadEnabled: true, isIntelligentTestRunnerEnabled: true, tags: {}
      })
      agentlessExporter.getLibraryConfiguration({}, () => {
        expect(scope.isDone()).to.be.true
        expect(agentlessExporter.canReportCodeCoverage()).to.be.true
        done()
      })
    })

    it('will not allow skippable request if ITR configuration fails', (done) => {
      // request will fail
      delete process.env.DD_API_KEY

      const scope = nock('http://www.example.com')
        .post('/api/v2/libraries/tests/services/setting')
        .reply(200, JSON.stringify({
          data: {
            attributes: {
              require_git: false,
              code_coverage: true,
              tests_skipping: true
            }
          }
        }))

      const agentlessExporter = new AgentlessCiVisibilityExporter({
        url, isGitUploadEnabled: true, isIntelligentTestRunnerEnabled: true, tags: {}
      })
      agentlessExporter.sendGitMetadata = () => {
        return new Promise(resolve => {
          agentlessExporter._resolveGit()
          resolve()
        })
      }

      agentlessExporter.getLibraryConfiguration({}, (err) => {
        expect(scope.isDone()).not.to.be.true
        expect(err.message).to.contain(
          'Request to settings endpoint was not done because Datadog API key is not defined'
        )
        expect(agentlessExporter.shouldRequestSkippableSuites()).to.be.false
        process.env.DD_API_KEY = '1'
        done()
      })
    })
  })

  context('if isTestDynamicInstrumentationEnabled is set', () => {
    it('should initialise DynamicInstrumentationLogsWriter', async () => {
      const agentProxyCiVisibilityExporter = new AgentlessCiVisibilityExporter({
        tags: {},
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
      const agentProxyCiVisibilityExporter = new AgentlessCiVisibilityExporter({
        tags: {},
        isTestDynamicInstrumentationEnabled: true
      })
      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
      agentProxyCiVisibilityExporter._logsWriter = mockWriter
      const log = { message: 'hello' }
      agentProxyCiVisibilityExporter.exportDiLogs({}, log)
      expect(mockWriter.append).to.have.been.calledWith(sinon.match(log))
    })
  })

  describe('url', () => {
    it('sets the default if URL param is not specified', () => {
      const site = 'd4tad0g.com'
      const agentlessExporter = new AgentlessCiVisibilityExporter({ site, tags: {} })
      expect(agentlessExporter._url.href).to.equal(`https://citestcycle-intake.${site}/`)
      expect(agentlessExporter._coverageUrl.href).to.equal(`https://citestcov-intake.${site}/`)
    })
  })
})
