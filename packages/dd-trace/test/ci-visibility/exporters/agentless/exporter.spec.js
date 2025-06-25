'use strict'

const t = require('tap')
require('../../../../../dd-trace/test/setup/core')

const cp = require('child_process')

const { expect } = require('chai')
const nock = require('nock')

const AgentlessCiVisibilityExporter = require('../../../../src/ci-visibility/exporters/agentless')
const DynamicInstrumentationLogsWriter = require('../../../../src/ci-visibility/exporters/agentless/di-logs-writer')

t.test('CI Visibility Agentless Exporter', t => {
  const url = new URL('http://www.example.com')

  t.beforeEach(() => {
    // to make sure `isShallowRepository` in `git.js` returns false
    sinon.stub(cp, 'execFileSync').returns('false')
    nock.cleanAll()
  })

  t.afterEach(() => {
    sinon.restore()
  })

  t.before(() => {
    process.env.DD_API_KEY = '1'
  })

  t.after(() => {
    delete process.env.DD_API_KEY
  })

  t.test('can use CI Vis protocol right away', t => {
    const agentlessExporter = new AgentlessCiVisibilityExporter({ url, isGitUploadEnabled: true, tags: {} })
    expect(agentlessExporter.canReportSessionTraces()).to.be.true
    t.end()
  })

  t.test('when ITR is enabled', t => {
    t.test('will request configuration to api.site by default', (t) => {
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
        t.end()
      })
    })

    t.test('will request skippable to api.site by default', (t) => {
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
          t.end()
        })
      })
    })

    t.test('can request ITR configuration right away', (t) => {
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
        t.end()
      })
    })

    t.test('can report code coverages if enabled by the API', (t) => {
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
        t.end()
      })
    })

    t.test('will not allow skippable request if ITR configuration fails', (t) => {
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
        t.end()
      })
    })
    t.end()
  })

  context('if isTestDynamicInstrumentationEnabled is set', () => {
    t.test('should initialise DynamicInstrumentationLogsWriter', async t => {
      const agentProxyCiVisibilityExporter = new AgentlessCiVisibilityExporter({
        tags: {},
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
      const agentProxyCiVisibilityExporter = new AgentlessCiVisibilityExporter({
        tags: {},
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

  t.test('url', t => {
    t.test('sets the default if URL param is not specified', t => {
      const site = 'd4tad0g.com'
      const agentlessExporter = new AgentlessCiVisibilityExporter({ site, tags: {} })
      expect(agentlessExporter._url.href).to.equal(`https://citestcycle-intake.${site}/`)
      expect(agentlessExporter._coverageUrl.href).to.equal(`https://citestcov-intake.${site}/`)
      t.end()
    })
    t.end()
  })
  t.end()
})
