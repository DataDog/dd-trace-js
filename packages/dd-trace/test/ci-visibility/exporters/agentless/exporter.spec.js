'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')

const { describe, it, beforeEach, afterEach, before, after } = require('mocha')
const context = describe
const sinon = require('sinon')
const nock = require('nock')

require('../../../../../dd-trace/test/setup/core')
const AgentlessCiVisibilityExporter = require('../../../../src/ci-visibility/exporters/agentless')
const DynamicInstrumentationLogsWriter = require('../../../../src/ci-visibility/exporters/agentless/di-logs-writer')

describe('CI Visibility Agentless Exporter', () => {
  const ciVisibilityAgentlessUrl = new URL('http://www.example.com')

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
    const agentlessExporter = new AgentlessCiVisibilityExporter({
      ciVisibilityAgentlessUrl,
      isGitUploadEnabled: true,
      tags: {},
    })
    assert.strictEqual(agentlessExporter.canReportSessionTraces(), true)
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
              tests_skipping: true,
            },
          },
        }))
      const agentlessExporter = new AgentlessCiVisibilityExporter({
        site: 'datadoge.c0m',
        isGitUploadEnabled: true,
        isIntelligentTestRunnerEnabled: true,
        tags: {},
      })
      agentlessExporter.getLibraryConfiguration({}, () => {
        assert.strictEqual(scope.isDone(), true)
        assert.strictEqual(agentlessExporter.canReportCodeCoverage(), true)
        assert.strictEqual(agentlessExporter.shouldRequestSkippableSuites(), true)
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
              tests_skipping: true,
            },
          },
        }))
        .post('/api/v2/ci/tests/skippable')
        .reply(200, JSON.stringify({
          data: [],
        }))

      const agentlessExporter = new AgentlessCiVisibilityExporter({
        site: 'datadoge.c0m',
        isGitUploadEnabled: true,
        isIntelligentTestRunnerEnabled: true,
        tags: {},
      })
      agentlessExporter._resolveGit()
      agentlessExporter.getLibraryConfiguration({}, () => {
        agentlessExporter.getSkippableSuites({}, () => {
          assert.strictEqual(scope.isDone(), true)
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
              tests_skipping: true,
            },
          },
        }))
      const agentlessExporter = new AgentlessCiVisibilityExporter({
        ciVisibilityAgentlessUrl, isGitUploadEnabled: true, isIntelligentTestRunnerEnabled: true, tags: {},
      })
      agentlessExporter.getLibraryConfiguration({}, () => {
        assert.strictEqual(scope.isDone(), true)
        assert.strictEqual(agentlessExporter.canReportCodeCoverage(), true)
        assert.strictEqual(agentlessExporter.shouldRequestSkippableSuites(), true)
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
              tests_skipping: true,
            },
          },
        }))
      const agentlessExporter = new AgentlessCiVisibilityExporter({
        ciVisibilityAgentlessUrl, isGitUploadEnabled: true, isIntelligentTestRunnerEnabled: true, tags: {},
      })
      agentlessExporter.getLibraryConfiguration({}, () => {
        assert.strictEqual(scope.isDone(), true)
        assert.strictEqual(agentlessExporter.canReportCodeCoverage(), true)
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
              tests_skipping: true,
            },
          },
        }))

      const agentlessExporter = new AgentlessCiVisibilityExporter({
        ciVisibilityAgentlessUrl, isGitUploadEnabled: true, isIntelligentTestRunnerEnabled: true, tags: {},
      })
      agentlessExporter.sendGitMetadata = () => {
        return new Promise(resolve => {
          agentlessExporter._resolveGit()
          resolve()
        })
      }

      agentlessExporter.getLibraryConfiguration({}, (err) => {
        assert.notStrictEqual(scope.isDone(), true)
        assert.ok(
          err.message.includes(
            'Request to settings endpoint was not done because Datadog API key is not defined'
          )
        )
        assert.strictEqual(agentlessExporter.shouldRequestSkippableSuites(), false)
        process.env.DD_API_KEY = '1'
        done()
      })
    })
  })

  context('if isTestDynamicInstrumentationEnabled is set', () => {
    it('should initialise DynamicInstrumentationLogsWriter', async () => {
      const agentProxyCiVisibilityExporter = new AgentlessCiVisibilityExporter({
        tags: {},
        isTestDynamicInstrumentationEnabled: true,
      })
      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
      assert.ok(agentProxyCiVisibilityExporter._logsWriter instanceof DynamicInstrumentationLogsWriter)
    })

    it('should process logs', async () => {
      const mockWriter = {
        append: sinon.spy(),
        flush: sinon.spy(),
      }
      const agentProxyCiVisibilityExporter = new AgentlessCiVisibilityExporter({
        tags: {},
        isTestDynamicInstrumentationEnabled: true,
      })
      await agentProxyCiVisibilityExporter._canUseCiVisProtocolPromise
      agentProxyCiVisibilityExporter._logsWriter = mockWriter
      const log = { message: 'hello' }
      agentProxyCiVisibilityExporter.exportDiLogs({}, log)
      sinon.assert.calledWith(mockWriter.append, sinon.match(log))
    })
  })

  describe('url', () => {
    it('sets the default if URL param is not specified', () => {
      const site = 'd4tad0g.com'
      const agentlessExporter = new AgentlessCiVisibilityExporter({ site, tags: {} })
      assert.strictEqual(agentlessExporter._url.href, `https://citestcycle-intake.${site}/`)
      assert.strictEqual(agentlessExporter._coverageUrl.href, `https://citestcov-intake.${site}/`)
    })
  })
})
