'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const { inspect } = require('node:util')

const { describe, it, beforeEach, afterEach, before, after } = require('mocha')
const context = describe
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')
const nock = require('nock')

require('../../../../../dd-trace/test/setup/core')
const AgentlessCiVisibilityExporterBase = require('../../../../src/ci-visibility/exporters/agentless')
const DynamicInstrumentationLogsWriter = require('../../../../src/ci-visibility/exporters/agentless/di-logs-writer')

// The real tracer Config always carries a `testOptimization` namespace object.
// Default it here so the partial config stand-ins below mirror that guarantee.
class AgentlessCiVisibilityExporter extends AgentlessCiVisibilityExporterBase {
  constructor (config) {
    super({ testOptimization: {}, ...config })
  }
}

// Used by the negative "no API key" test to inject a stubbed getConfig singleton into
// the request chain. The stubbed singleton still pulls every other field from the real
// tracer Config so the rest of the exporter behaves normally.
function loadAgentlessExporterWithFakeConfig (fakeConfig) {
  const realConfig = require('../../../../src/config')()
  const getLibraryConfiguration = proxyquire('../../../../src/ci-visibility/requests/get-library-configuration', {
    '../../config': () => ({ ...realConfig, ...fakeConfig }),
  })
  const CiVisibilityExporter = proxyquire('../../../../src/ci-visibility/exporters/ci-visibility-exporter', {
    '../requests/get-library-configuration': getLibraryConfiguration,
  })
  return proxyquire('../../../../src/ci-visibility/exporters/agentless', {
    '../ci-visibility-exporter': CiVisibilityExporter,
  })
}

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
    const agentlessExporter = new AgentlessCiVisibilityExporter({
      DD_CIVISIBILITY_AGENTLESS_URL: url, testOptimization: { DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: true }, tags: {},
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
        testOptimization: {
          DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: true,
          DD_CIVISIBILITY_ITR_ENABLED: true,
        },
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
        testOptimization: {
          DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: true,
          DD_CIVISIBILITY_ITR_ENABLED: true,
        },
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
        DD_CIVISIBILITY_AGENTLESS_URL: url,
        testOptimization: {
          DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: true,
          DD_CIVISIBILITY_ITR_ENABLED: true,
        },
        tags: {},
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
        DD_CIVISIBILITY_AGENTLESS_URL: url,
        testOptimization: {
          DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: true,
          DD_CIVISIBILITY_ITR_ENABLED: true,
        },
        tags: {},
      })
      agentlessExporter.getLibraryConfiguration({}, () => {
        assert.strictEqual(scope.isDone(), true)
        assert.strictEqual(agentlessExporter.canReportCodeCoverage(), true)
        done()
      })
    })

    it('will not allow skippable request if ITR configuration fails', (done) => {
      // Stub the API key to be missing so the request is never sent.
      const AgentlessCiVisibilityExporter = loadAgentlessExporterWithFakeConfig({ DD_API_KEY: undefined })

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
        DD_CIVISIBILITY_AGENTLESS_URL: url,
        testOptimization: {
          DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: true,
          DD_CIVISIBILITY_ITR_ENABLED: true,
        },
        tags: {},
      })
      agentlessExporter.sendGitMetadata = () => {
        return /** @type {Promise<void>} */ (new Promise(resolve => {
          agentlessExporter._resolveGit()
          resolve()
        }))
      }

      agentlessExporter.getLibraryConfiguration({}, (err) => {
        assert.notStrictEqual(scope.isDone(), true)
        assert.ok(
          err.message.includes('Request to settings endpoint was not done because Datadog API key is not defined'),
          `Got: ${inspect(err.message)}`
        )
        assert.strictEqual(agentlessExporter.shouldRequestSkippableSuites(), false)
        done()
      })
    })
  })

  context('if isTestDynamicInstrumentationEnabled is set', () => {
    it('should initialise DynamicInstrumentationLogsWriter', async () => {
      const agentProxyCiVisibilityExporter = new AgentlessCiVisibilityExporter({
        tags: {},
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
      const agentProxyCiVisibilityExporter = new AgentlessCiVisibilityExporter({
        tags: {},
        testOptimization: { DD_TEST_FAILED_TEST_REPLAY_ENABLED: true },
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

    it('uses DD_CIVISIBILITY_AGENTLESS_URL as the intake override for every endpoint', () => {
      const agentlessExporter = new AgentlessCiVisibilityExporter({
        DD_CIVISIBILITY_AGENTLESS_URL: url, site: 'd4tad0g.com', tags: {},
      })
      assert.strictEqual(agentlessExporter._url.href, 'http://www.example.com/')
      assert.strictEqual(agentlessExporter._coverageUrl.href, 'http://www.example.com/')
      assert.strictEqual(agentlessExporter._apiUrl.href, 'http://www.example.com/')
    })
  })
})
