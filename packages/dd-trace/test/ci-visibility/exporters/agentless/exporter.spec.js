'use strict'

require('../../../../../dd-trace/test/setup/tap')

const cp = require('child_process')

const { expect } = require('chai')
const nock = require('nock')

const AgentlessCiVisibilityExporter = require('../../../../src/ci-visibility/exporters/agentless')

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
      expect(agentlessExporter.shouldRequestItrConfiguration()).to.be.true
      agentlessExporter.getItrConfiguration({}, () => {
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
      agentlessExporter.getItrConfiguration({}, () => {
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
              code_coverage: true,
              tests_skipping: true
            }
          }
        }))
      const agentlessExporter = new AgentlessCiVisibilityExporter({
        url, isGitUploadEnabled: true, isIntelligentTestRunnerEnabled: true, tags: {}
      })
      expect(agentlessExporter.shouldRequestItrConfiguration()).to.be.true
      agentlessExporter.getItrConfiguration({}, () => {
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
              code_coverage: true,
              tests_skipping: true
            }
          }
        }))
      const agentlessExporter = new AgentlessCiVisibilityExporter({
        url, isGitUploadEnabled: true, isIntelligentTestRunnerEnabled: true, tags: {}
      })
      agentlessExporter.getItrConfiguration({}, () => {
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

      expect(agentlessExporter.shouldRequestItrConfiguration()).to.be.true
      agentlessExporter.getItrConfiguration({}, (err) => {
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

  describe('url', () => {
    it('sets the default if URL param is not specified', () => {
      const site = 'd4tad0g.com'
      const agentlessExporter = new AgentlessCiVisibilityExporter({ site, tags: {} })
      expect(agentlessExporter._url.href).to.equal(`https://citestcycle-intake.${site}/`)
      expect(agentlessExporter._coverageUrl.href).to.equal(`https://citestcov-intake.${site}/`)
    })
  })
})
