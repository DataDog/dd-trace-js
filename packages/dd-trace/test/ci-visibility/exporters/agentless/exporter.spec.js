'use strict'
const { expect } = require('chai')
const nock = require('nock')

const AgentlessCiVisibilityExporter = require('../../../../src/ci-visibility/exporters/agentless')

describe('CI Visibility Agentless Exporter', () => {
  const url = new URL('http://www.example.com')

  beforeEach(() => {
    nock.cleanAll()
  })

  before(() => {
    process.env.DD_API_KEY = '1'
    process.env.DD_APP_KEY = '1'
  })

  after(() => {
    delete process.env.DD_API_KEY
    delete process.env.DD_APP_KEY
  })

  it('uploads git metadata if configured to do so', (done) => {
    const scope = nock('http://www.example.com')
      .post('/api/v2/git/repository/search_commits')
      .reply(200, JSON.stringify({
        data: []
      }))
      .post('/api/v2/git/repository/packfile')
      .reply(202, '')

    const agentlessExporter = new AgentlessCiVisibilityExporter({ url, isGitUploadEnabled: true, tags: {} })
    agentlessExporter._gitUploadPromise.then(() => {
      expect(scope.isDone()).to.be.true
      done()
    })
  })

  it('can use CI Vis protocol right away', () => {
    const agentlessExporter = new AgentlessCiVisibilityExporter({ url, isGitUploadEnabled: true, tags: {} })
    expect(agentlessExporter.canReportCodeCoverage()).to.be.true
    expect(agentlessExporter.canReportSessionTraces()).to.be.true
  })

  describe('when ITR is enabled', () => {
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
        expect(agentlessExporter.shouldRequestSkippableSuites()).to.be.true
        done()
      })
    })
    it('will not allow skippable request if ITR configuration fails', (done) => {
      // request will fail
      delete process.env.DD_APP_KEY

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
      agentlessExporter.getItrConfiguration({}, ({ err }) => {
        expect(scope.isDone()).not.to.be.true
        expect(err.message).to.contain('App key or API key undefined')
        expect(agentlessExporter.shouldRequestSkippableSuites()).to.be.false
        done()
      })
    })
  })

  describe('url', () => {
    it('sets the default if URL param is not specified', () => {
      const site = 'd4tad0g.com'
      const agentlessExporter = new AgentlessCiVisibilityExporter({ site, tags: {} })
      expect(agentlessExporter._url.href).to.equal(`https://citestcycle-intake.${site}/`)
      expect(agentlessExporter._coverageUrl.href).to.equal(`https://event-platform-intake.${site}/`)
    })
  })
})
