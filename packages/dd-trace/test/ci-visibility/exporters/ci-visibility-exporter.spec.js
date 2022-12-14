'use strict'

const CiVisibilityExporter = require('../../../src/ci-visibility/exporters/ci-visibility-exporter')
const nock = require('nock')

describe('CI Visibility Exporter', () => {
  const port = 8126

  beforeEach(() => {
    process.env.DD_API_KEY = '1'
    process.env.DD_APP_KEY = '1'
    nock.cleanAll()
  })

  describe('sendGitMetadata', () => {
    it('should resolve _gitUploadPromise when git metadata is fetched', (done) => {
      const scope = nock(`http://localhost:${port}`)
        .post('/api/v2/git/repository/search_commits')
        .reply(200, JSON.stringify({
          data: []
        }))
        .post('/api/v2/git/repository/packfile')
        .reply(202, '')

      const ciVisibilityExporter = new CiVisibilityExporter({ port })

      ciVisibilityExporter._gitUploadPromise.then((err) => {
        expect(err).not.to.exist
        expect(scope.isDone()).to.be.true
        done()
      })

      const url = new URL(`http://localhost:${port}`)
      ciVisibilityExporter.sendGitMetadata({ url, isEvpProxy: false })
    })
    it('should resolve _gitUploadPromise with an error when git metadata request fails', (done) => {
      const scope = nock(`http://localhost:${port}`)
        .post('/api/v2/git/repository/search_commits')
        .reply(404)

      const ciVisibilityExporter = new CiVisibilityExporter({ port })

      ciVisibilityExporter._gitUploadPromise.then((err) => {
        expect(err.message).to.include('Error fetching commits to exclude')
        expect(scope.isDone()).to.be.true
        done()
      })

      const url = new URL(`http://localhost:${port}`)
      ciVisibilityExporter.sendGitMetadata({ url, isEvpProxy: false })
    })
  })

  describe('getItrConfiguration', () => {
    context('if ITR is not enabled', () => {
      it('should resolve immediately if ITR is not enabled', (done) => {
        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/libraries/tests/services/setting')
          .reply(200)

        const ciVisibilityExporter = new CiVisibilityExporter({ port })
        ciVisibilityExporter.getItrConfiguration({}, ({ err, itrConfig }) => {
          expect(itrConfig).to.eql({})
          expect(err).to.be.undefined
          expect(scope.isDone()).not.to.be.true
          done()
        })
      })
    })
    context('if ITR is enabled', () => {
      it('should request the API after EVP proxy is resolved if ITR is enabled', (done) => {
        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/libraries/tests/services/setting')
          .reply(200, JSON.stringify({
            data: {
              attributes: {
                code_coverage: true,
                tests_skipping: true
              }
            }
          }))

        const ciVisibilityExporter = new CiVisibilityExporter({ port, isIntelligentTestRunnerEnabled: true })

        ciVisibilityExporter.getItrConfiguration({}, ({ err, itrConfig }) => {
          expect(itrConfig).to.eql({
            isCodeCoverageEnabled: true,
            isSuitesSkippingEnabled: true
          })
          expect(err).not.to.exist
          expect(scope.isDone()).to.be.true
          done()
        })
        ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
      })
      it('should update shouldRequestSkippableSuites if test skipping is enabled', (done) => {
        nock(`http://localhost:${port}`)
          .post('/api/v2/libraries/tests/services/setting')
          .reply(200, JSON.stringify({
            data: {
              attributes: {
                code_coverage: true,
                tests_skipping: true
              }
            }
          }))

        const ciVisibilityExporter = new CiVisibilityExporter({ port, isIntelligentTestRunnerEnabled: true })
        expect(ciVisibilityExporter.shouldRequestSkippableSuites()).to.be.false

        ciVisibilityExporter.getItrConfiguration({}, () => {
          expect(ciVisibilityExporter.shouldRequestSkippableSuites()).to.be.true
          done()
        })
        ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
      })
    })
  })

  describe('getSkippableSuites', () => {
    context('if ITR is not enabled', () => {
      it('should resolve immediately with an empty array', (done) => {
        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/ci/tests/skippable')
          .reply(200)

        const ciVisibilityExporter = new CiVisibilityExporter({ port })
        ciVisibilityExporter.getSkippableSuites({}, ({ skippableSuites }) => {
          expect(skippableSuites).to.eql([])
          expect(scope.isDone()).not.to.be.true
          done()
        })
      })
    })
    context('if ITR is enabled but the tracer can not use CI Vis protocol', () => {
      it('should resolve immediately with an empty array', (done) => {
        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/ci/tests/skippable')
          .reply(200)

        const ciVisibilityExporter = new CiVisibilityExporter({ port, isIntelligentTestRunnerEnabled: true })

        ciVisibilityExporter._resolveCanUseCiVisProtocol(false)
        ciVisibilityExporter._resolveGit()

        ciVisibilityExporter.getSkippableSuites({}, ({ skippableSuites }) => {
          expect(skippableSuites).to.eql([])
          expect(scope.isDone()).not.to.be.true
          done()
        })
      })
    })
    context('if ITR is enabled and the tracer can use CI Vis Protocol', () => {
      it('should request the API after git upload promise is resolved', (done) => {
        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/ci/tests/skippable')
          .reply(200, JSON.stringify({
            data: [{
              type: 'suite',
              attributes: {
                suite: 'ci-visibility/test/ci-visibility-test.js'
              }
            }]
          }))

        const ciVisibilityExporter = new CiVisibilityExporter({ port, isIntelligentTestRunnerEnabled: true })

        ciVisibilityExporter._itrConfig = { isSuitesSkippingEnabled: true }
        ciVisibilityExporter._resolveCanUseCiVisProtocol(true)

        ciVisibilityExporter.getSkippableSuites({}, ({ skippableSuites }) => {
          expect(skippableSuites).to.eql(['ci-visibility/test/ci-visibility-test.js'])
          expect(scope.isDone()).to.be.true
          done()
        })
        ciVisibilityExporter._resolveGit()
      })
    })
    context('if ITR is enabled and the tracer can use CI Vis Protocol but git upload fails', () => {
      it('should not request the API and resolve with an empty array', (done) => {
        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/ci/tests/skippable')
          .reply(200)

        const ciVisibilityExporter = new CiVisibilityExporter({ port, isIntelligentTestRunnerEnabled: true })

        ciVisibilityExporter._itrConfig = { isSuitesSkippingEnabled: true }
        ciVisibilityExporter._resolveCanUseCiVisProtocol(true)

        ciVisibilityExporter.getSkippableSuites({}, ({ err, skippableSuites }) => {
          expect(err.message).to.include('could not upload git metadata')
          expect(skippableSuites).to.eql([])
          expect(scope.isDone()).not.to.be.true
          done()
        })
        ciVisibilityExporter._resolveGit(new Error('could not upload git metadata'))
      })
    })
  })

  describe('export', () => {
    context('is not initialized', () => {
      it('should store traces in a buffer', () => {
        const trace = []
        const ciVisibilityExporter = new CiVisibilityExporter({ port })
        ciVisibilityExporter.export(trace)
        ciVisibilityExporter._export = sinon.spy()
        expect(ciVisibilityExporter._traceBuffer).to.include(trace)
        expect(ciVisibilityExporter._export).not.to.be.called
      })
    })
    context('is initialized', () => {
      it('should export traces', () => {
        const writer = {
          append: sinon.spy(),
          flush: sinon.spy(),
          setUrl: sinon.spy()
        }
        const trace = []
        const ciVisibilityExporter = new CiVisibilityExporter({ port })
        ciVisibilityExporter._isInitialized = true
        ciVisibilityExporter._writer = writer
        ciVisibilityExporter.export(trace)
        expect(ciVisibilityExporter._traceBuffer).not.to.include(trace)
        expect(ciVisibilityExporter._writer.append).to.be.called
      })
    })
    context('is initialized and can not use CI Vis protocol', () => {
      it('should not export session traces', () => {
        const writer = {
          append: sinon.spy(),
          flush: sinon.spy(),
          setUrl: sinon.spy()
        }
        const trace = [{
          type: 'test_session_end'
        }]
        const ciVisibilityExporter = new CiVisibilityExporter({ port })
        ciVisibilityExporter._isInitialized = true
        ciVisibilityExporter._writer = writer
        ciVisibilityExporter.export(trace)
        expect(ciVisibilityExporter._traceBuffer).not.to.include(trace)
        expect(ciVisibilityExporter._writer.append).not.to.be.called
      })
    })
    context('is initialized and can use CI Vis protocol', () => {
      it('should export session traces', () => {
        const writer = {
          append: sinon.spy(),
          flush: sinon.spy(),
          setUrl: sinon.spy()
        }
        const trace = [{
          type: 'test_session_end'
        }]
        const ciVisibilityExporter = new CiVisibilityExporter({ port })
        ciVisibilityExporter._isInitialized = true
        ciVisibilityExporter._writer = writer
        ciVisibilityExporter._canUseCiVisProtocol = true
        ciVisibilityExporter.export(trace)
        expect(ciVisibilityExporter._traceBuffer).not.to.include(trace)
        expect(ciVisibilityExporter._writer.append).to.be.called
      })
    })
  })

  describe('exportCoverage', () => {
    context('is not initialized', () => {
      it('should store coverages in a buffer', () => {
        const coverage = {}
        const ciVisibilityExporter = new CiVisibilityExporter({ port })
        ciVisibilityExporter.exportCoverage(coverage)
        ciVisibilityExporter._export = sinon.spy()
        expect(ciVisibilityExporter._coverageBuffer).to.include(coverage)
        expect(ciVisibilityExporter._export).not.to.be.called
      })
    })
    context('is initialized but can not use CI Vis protocol', () => {
      it('should not export coverages', () => {
        const writer = {
          append: sinon.spy(),
          flush: sinon.spy(),
          setUrl: sinon.spy()
        }
        const coverage = {}
        const ciVisibilityExporter = new CiVisibilityExporter({ port })
        ciVisibilityExporter._isInitialized = true
        ciVisibilityExporter._coverageWriter = writer
        ciVisibilityExporter.exportCoverage(coverage)
        expect(ciVisibilityExporter._coverageBuffer).not.to.include(coverage)
        expect(ciVisibilityExporter._coverageWriter.append).not.to.be.called
      })
    })
    context('is initialized and can use CI Vis protocol', () => {
      it('should export coverages', () => {
        const writer = {
          append: sinon.spy(),
          flush: sinon.spy(),
          setUrl: sinon.spy()
        }
        const coverage = {
          span: {
            context: () => ({})
          }
        }
        const ciVisibilityExporter = new CiVisibilityExporter({ port })
        ciVisibilityExporter._isInitialized = true
        ciVisibilityExporter._coverageWriter = writer
        ciVisibilityExporter._canUseCiVisProtocol = true

        ciVisibilityExporter.exportCoverage(coverage)
        expect(ciVisibilityExporter._coverageBuffer).not.to.include(coverage)
        expect(ciVisibilityExporter._coverageWriter.append).to.be.called
      })
    })
  })
})
