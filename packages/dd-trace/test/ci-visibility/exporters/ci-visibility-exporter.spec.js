'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach, context } = require('tap').mocha
const sinon = require('sinon')
const nock = require('nock')
const cp = require('node:child_process')
const fs = require('node:fs')
const zlib = require('node:zlib')

require('../../../../dd-trace/test/setup/tap')

const CiVisibilityExporter = require('../../../src/ci-visibility/exporters/ci-visibility-exporter')

describe('CI Visibility Exporter', () => {
  const port = 8126

  beforeEach(() => {
    // to make sure `isShallowRepository` in `git.js` returns false
    sinon.stub(cp, 'execFileSync').returns('false')
    sinon.stub(fs, 'readFileSync').returns('')
    process.env.DD_API_KEY = '1'
    nock.cleanAll()
  })

  afterEach(() => {
    sinon.restore()
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

      const url = new URL(`http://localhost:${port}`)
      const ciVisibilityExporter = new CiVisibilityExporter({ url, isGitUploadEnabled: true })

      ciVisibilityExporter._gitUploadPromise.then((err) => {
        expect(err).not.to.exist
        expect(scope.isDone()).to.be.true
        done()
      })
      ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
      ciVisibilityExporter.sendGitMetadata()
    })

    it('should resolve _gitUploadPromise with an error when git metadata request fails', (done) => {
      const scope = nock(`http://localhost:${port}`)
        .post('/api/v2/git/repository/search_commits')
        .reply(404)

      const url = new URL(`http://localhost:${port}`)
      const ciVisibilityExporter = new CiVisibilityExporter({ url, isGitUploadEnabled: true })

      ciVisibilityExporter._gitUploadPromise.then((err) => {
        expect(err.message).to.include('Error fetching commits to exclude')
        expect(scope.isDone()).to.be.true
        done()
      })
      ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
      ciVisibilityExporter.sendGitMetadata()
    })

    it('should use the input repository URL', (done) => {
      nock(`http://localhost:${port}`)
        .post('/api/v2/git/repository/search_commits')
        .reply(200, function () {
          const { meta: { repository_url: repositoryUrl } } = JSON.parse(this.req.requestBodyBuffers.toString())
          expect(repositoryUrl).to.equal('https://custom-git@datadog.com')
          done()
        })
        .post('/api/v2/git/repository/packfile')
        .reply(202, '')

      const url = new URL(`http://localhost:${port}`)
      const ciVisibilityExporter = new CiVisibilityExporter({ url, isGitUploadEnabled: true })

      ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
      ciVisibilityExporter.sendGitMetadata('https://custom-git@datadog.com')
    })
  })

  describe('getLibraryConfiguration', () => {
    it('should upload git metadata when getLibraryConfiguration is called, regardless of ITR config', (done) => {
      const scope = nock(`http://localhost:${port}`)
        .post('/api/v2/git/repository/search_commits')
        .reply(200, JSON.stringify({
          data: []
        }))
        .post('/api/v2/git/repository/packfile')
        .reply(202, '')

      const ciVisibilityExporter = new CiVisibilityExporter({ port, isGitUploadEnabled: true })
      ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
      ciVisibilityExporter.getLibraryConfiguration({}, () => {})
      ciVisibilityExporter._gitUploadPromise.then(() => {
        expect(scope.isDone()).to.be.true
        done()
      })
    })
    context('if ITR is disabled', () => {
      it('should resolve immediately and not request settings', (done) => {
        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/libraries/tests/services/setting')
          .reply(200)

        const ciVisibilityExporter = new CiVisibilityExporter({ port })
        ciVisibilityExporter.getLibraryConfiguration({}, (err, libraryConfig) => {
          expect(libraryConfig).to.eql({})
          expect(err).to.be.null
          expect(scope.isDone()).not.to.be.true
          done()
        })
      })
    })
    context('if ITR is enabled', () => {
      it('should add custom configurations', (done) => {
        let customConfig
        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/libraries/tests/services/setting', function (body) {
            customConfig = body.data.attributes.configurations.custom
            return true
          })
          .reply(200, JSON.stringify({
            data: {
              attributes: {
                itr_enabled: true,
                require_git: false,
                code_coverage: true,
                tests_skipping: true
              }
            }
          }))

        const ciVisibilityExporter = new CiVisibilityExporter({
          port,
          isIntelligentTestRunnerEnabled: true,
          tags: {
            'test.configuration.my_custom_config': 'my_custom_config_value'
          }
        })

        ciVisibilityExporter.getLibraryConfiguration({}, () => {
          expect(scope.isDone()).to.be.true
          expect(customConfig).to.eql({
            my_custom_config: 'my_custom_config_value'
          })
          done()
        })
        ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
      })
      it('should handle git metadata with tag but no branch', (done) => {
        let requestBody
        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/libraries/tests/services/setting', function (body) {
            requestBody = body
            return true
          })
          .reply(200, JSON.stringify({
            data: {
              attributes: {
                itr_enabled: true,
                require_git: false,
                code_coverage: true,
                tests_skipping: true
              }
            }
          }))
        const ciVisibilityExporter = new CiVisibilityExporter({
          port,
          isIntelligentTestRunnerEnabled: true
        })
        const testConfiguration = {
          tag: 'v1.0.0'
        }
        ciVisibilityExporter.getLibraryConfiguration(testConfiguration, (err, libraryConfig) => {
          expect(err).to.be.null
          expect(libraryConfig).to.contain({
            requireGit: false,
            isCodeCoverageEnabled: true,
            isItrEnabled: true,
            isSuitesSkippingEnabled: true
          })
          expect(scope.isDone()).to.be.true
          expect(requestBody.data.attributes.branch).to.equal('v1.0.0')
          done()
        })
        ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
      })
      it('should request the API after EVP proxy is resolved', (done) => {
        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/libraries/tests/services/setting')
          .reply(200, JSON.stringify({
            data: {
              attributes: {
                itr_enabled: true,
                require_git: false,
                code_coverage: true,
                tests_skipping: true,
                known_tests_enabled: false
              }
            }
          }))

        const ciVisibilityExporter = new CiVisibilityExporter({ port, isIntelligentTestRunnerEnabled: true })

        ciVisibilityExporter.getLibraryConfiguration({}, (err, libraryConfig) => {
          expect(libraryConfig).to.contain({
            requireGit: false,
            isCodeCoverageEnabled: true,
            isItrEnabled: true,
            isSuitesSkippingEnabled: true,
            isEarlyFlakeDetectionEnabled: false
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
                itr_enabled: true,
                require_git: false,
                code_coverage: true,
                tests_skipping: true
              }
            }
          }))

        const ciVisibilityExporter = new CiVisibilityExporter({ port, isIntelligentTestRunnerEnabled: true })
        expect(ciVisibilityExporter.shouldRequestSkippableSuites()).to.be.false

        ciVisibilityExporter.getLibraryConfiguration({}, () => {
          expect(ciVisibilityExporter.shouldRequestSkippableSuites()).to.be.true
          done()
        })
        ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
      })
      it('will retry ITR configuration request if require_git is true', (done) => {
        const TIME_TO_UPLOAD_GIT = 50
        let hasUploadedGit = false
        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/libraries/tests/services/setting')
          .reply(200, JSON.stringify({
            data: {
              attributes: {
                require_git: true,
                code_coverage: true,
                tests_skipping: true
              }
            }
          }))
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

        const ciVisibilityExporter = new CiVisibilityExporter({
          port, isIntelligentTestRunnerEnabled: true
        })
        ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
        expect(ciVisibilityExporter.shouldRequestLibraryConfiguration()).to.be.true
        ciVisibilityExporter.getLibraryConfiguration({}, (err, libraryConfig) => {
          expect(scope.isDone()).to.be.true
          expect(err).to.be.null
          // the second request returns require_git: false
          expect(libraryConfig.requireGit).to.be.false
          expect(hasUploadedGit).to.be.true
          done()
        })
        // Git upload finishes after a bit
        setTimeout(() => {
          ciVisibilityExporter._resolveGit()
          hasUploadedGit = true
        }, TIME_TO_UPLOAD_GIT)
      })
      it('will retry ITR configuration request immediately if git upload is already finished', (done) => {
        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/libraries/tests/services/setting')
          .reply(200, JSON.stringify({
            data: {
              attributes: {
                require_git: true,
                code_coverage: true,
                tests_skipping: true
              }
            }
          }))
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

        const ciVisibilityExporter = new CiVisibilityExporter({
          port, isIntelligentTestRunnerEnabled: true
        })
        ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
        expect(ciVisibilityExporter.shouldRequestLibraryConfiguration()).to.be.true
        ciVisibilityExporter.getLibraryConfiguration({}, (err, libraryConfig) => {
          expect(scope.isDone()).to.be.true
          expect(err).to.be.null
          // the second request returns require_git: false
          expect(libraryConfig.requireGit).to.be.false
          done()
        })
        ciVisibilityExporter._resolveGit()
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
        ciVisibilityExporter.getSkippableSuites({}, (err, skippableSuites) => {
          expect(err).to.be.null
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

        ciVisibilityExporter.getSkippableSuites({}, (err, skippableSuites) => {
          expect(err).to.be.null
          expect(skippableSuites).to.eql([])
          expect(scope.isDone()).not.to.be.true
          done()
        })
      })
    })
    context('if ITR is enabled and the tracer can use CI Vis Protocol', () => {
      it('should add custom configurations', (done) => {
        let customConfig

        nock(`http://localhost:${port}`)
          .post('/api/v2/git/repository/search_commits')
          .reply(200, JSON.stringify({
            data: []
          }))
          .post('/api/v2/git/repository/packfile')
          .reply(202, '')

        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/ci/tests/skippable', function (body) {
            customConfig = body.data.attributes.configurations.custom
            return true
          })
          .reply(200, JSON.stringify({
            data: [{
              type: 'suite',
              attributes: {
                suite: 'ci-visibility/test/ci-visibility-test.js'
              }
            }]
          }))

        const ciVisibilityExporter = new CiVisibilityExporter({
          port,
          isIntelligentTestRunnerEnabled: true,
          isGitUploadEnabled: true,
          tags: {
            'test.configuration.my_custom_config_2': 'my_custom_config_value_2'
          }
        })

        ciVisibilityExporter._libraryConfig = { isSuitesSkippingEnabled: true }
        ciVisibilityExporter._resolveCanUseCiVisProtocol(true)

        ciVisibilityExporter.getSkippableSuites({}, () => {
          expect(scope.isDone()).to.be.true
          expect(customConfig).to.eql({
            my_custom_config_2: 'my_custom_config_value_2'
          })
          done()
        })
        ciVisibilityExporter.sendGitMetadata()
      })
      it('should request the API after git upload promise is resolved', (done) => {
        nock(`http://localhost:${port}`)
          .post('/api/v2/git/repository/search_commits')
          .reply(200, JSON.stringify({
            data: []
          }))
          .post('/api/v2/git/repository/packfile')
          .reply(202, '')

        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/ci/tests/skippable')
          .reply(200, JSON.stringify({
            meta: {
              correlation_id: '1234'
            },
            data: [{
              type: 'suite',
              attributes: {
                suite: 'ci-visibility/test/ci-visibility-test.js'
              }
            }]
          }))

        const ciVisibilityExporter = new CiVisibilityExporter({
          port,
          isIntelligentTestRunnerEnabled: true,
          isGitUploadEnabled: true
        })

        ciVisibilityExporter._libraryConfig = { isSuitesSkippingEnabled: true }
        ciVisibilityExporter._resolveCanUseCiVisProtocol(true)

        ciVisibilityExporter.getSkippableSuites({}, (err, skippableSuites) => {
          expect(err).to.be.null
          expect(skippableSuites).to.eql(['ci-visibility/test/ci-visibility-test.js'])
          expect(scope.isDone()).to.be.true
          done()
        })
        ciVisibilityExporter.sendGitMetadata()
      })
    })
    context('if ITR is enabled and the tracer can use CI Vis Protocol but git upload fails', () => {
      it('should not request the API and resolve with an empty array', (done) => {
        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/ci/tests/skippable')
          .reply(200)

        const ciVisibilityExporter = new CiVisibilityExporter({ port, isIntelligentTestRunnerEnabled: true })

        ciVisibilityExporter._libraryConfig = { isSuitesSkippingEnabled: true }
        ciVisibilityExporter._resolveCanUseCiVisProtocol(true)

        ciVisibilityExporter.getSkippableSuites({}, (err, skippableSuites) => {
          expect(err.message).to.include('could not upload git metadata')
          expect(skippableSuites).to.eql([])
          expect(scope.isDone()).not.to.be.true
          done()
        })
        ciVisibilityExporter._resolveGit(new Error('could not upload git metadata'))
      })
    })
    context('if ITR is enabled and the exporter can use gzip', () => {
      it('should request the API with gzip', (done) => {
        nock(`http://localhost:${port}`)
          .post('/api/v2/git/repository/search_commits')
          .reply(200, JSON.stringify({
            data: []
          }))
          .post('/api/v2/git/repository/packfile')
          .reply(202, '')

        let requestHeaders = {}
        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/ci/tests/skippable')
          .reply(200, function () {
            requestHeaders = this.req.headers

            return zlib.gzipSync(
              JSON.stringify({
                meta: {
                  correlation_id: '1234'
                },
                data: [{
                  type: 'suite',
                  attributes: {
                    suite: 'ci-visibility/test/ci-visibility-test.js'
                  }
                }]
              })
            )
          }, {
            'content-encoding': 'gzip'
          })
        const ciVisibilityExporter = new CiVisibilityExporter({
          port,
          isIntelligentTestRunnerEnabled: true,
          isGitUploadEnabled: true
        })
        ciVisibilityExporter._libraryConfig = { isSuitesSkippingEnabled: true }
        ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
        ciVisibilityExporter._isGzipCompatible = true

        ciVisibilityExporter.getSkippableSuites({}, (err, skippableSuites) => {
          expect(err).to.be.null
          expect(skippableSuites).to.eql(['ci-visibility/test/ci-visibility-test.js'])
          expect(scope.isDone()).to.be.true
          expect(requestHeaders['accept-encoding']).to.equal('gzip')
          done()
        })
        ciVisibilityExporter.sendGitMetadata()
      })
    })
    context('if ITR is enabled and the exporter can not use gzip', () => {
      it('should request the API without gzip', (done) => {
        nock(`http://localhost:${port}`)
          .post('/api/v2/git/repository/search_commits')
          .reply(200, JSON.stringify({
            data: []
          }))
          .post('/api/v2/git/repository/packfile')
          .reply(202, '')

        let requestHeaders = {}
        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/ci/tests/skippable')
          .reply(200, function () {
            requestHeaders = this.req.headers

            return JSON.stringify({
              meta: {
                correlation_id: '1234'
              },
              data: [{
                type: 'suite',
                attributes: {
                  suite: 'ci-visibility/test/ci-visibility-test.js'
                }
              }]
            })
          })
        const ciVisibilityExporter = new CiVisibilityExporter({
          port,
          isIntelligentTestRunnerEnabled: true,
          isGitUploadEnabled: true
        })
        ciVisibilityExporter._libraryConfig = { isSuitesSkippingEnabled: true }
        ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
        ciVisibilityExporter._isGzipCompatible = false

        ciVisibilityExporter.getSkippableSuites({}, (err, skippableSuites) => {
          expect(err).to.be.null
          expect(skippableSuites).to.eql(['ci-visibility/test/ci-visibility-test.js'])
          expect(scope.isDone()).to.be.true
          expect(requestHeaders['accept-encoding']).not.to.equal('gzip')
          done()
        })
        ciVisibilityExporter.sendGitMetadata()
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
          traceId: '1',
          spanId: '2',
          files: ['example.js']
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

  describe('getKnownTests', () => {
    context('if known tests is disabled', () => {
      it('should resolve to undefined', (done) => {
        const knownTestsScope = nock(`http://localhost:${port}`)
          .post('/api/v2/ci/libraries/tests')
          .reply(200)

        const ciVisibilityExporter = new CiVisibilityExporter({
          port
        })

        ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
        ciVisibilityExporter._libraryConfig = { isKnownTestsEnabled: false }

        ciVisibilityExporter.getKnownTests({}, (err, knownTests) => {
          expect(err).to.be.null
          expect(knownTests).to.eql(undefined)
          expect(knownTestsScope.isDone()).not.to.be.true
          done()
        })
      })
    })

    context('if known tests is enabled but can not use CI Visibility protocol', () => {
      it('should not request known tests', (done) => {
        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/ci/libraries/tests')
          .reply(200)

        const ciVisibilityExporter = new CiVisibilityExporter({ port })

        ciVisibilityExporter._resolveCanUseCiVisProtocol(false)
        ciVisibilityExporter._libraryConfig = { isKnownTestsEnabled: true }

        ciVisibilityExporter.getKnownTests({}, (err) => {
          expect(err).to.be.null
          expect(scope.isDone()).not.to.be.true
          done()
        })
      })
    })

    context('if known tests is enabled and can use CI Vis Protocol', () => {
      it('should request known tests', (done) => {
        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/ci/libraries/tests')
          .reply(200, JSON.stringify({
            data: {
              attributes: {
                tests: {
                  jest: {
                    suite1: ['test1'],
                    suite2: ['test2']
                  }
                }
              }
            }
          }))

        const ciVisibilityExporter = new CiVisibilityExporter({ port })

        ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
        ciVisibilityExporter._libraryConfig = { isKnownTestsEnabled: true }
        ciVisibilityExporter.getKnownTests({}, (err, knownTests) => {
          expect(err).to.be.null
          expect(knownTests).to.eql({
            jest: {
              suite1: ['test1'],
              suite2: ['test2']
            }
          })
          expect(scope.isDone()).to.be.true
          done()
        })
      })

      it('should return an error if the request fails', (done) => {
        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/ci/libraries/tests')
          .reply(500)
        const ciVisibilityExporter = new CiVisibilityExporter({ port })

        ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
        ciVisibilityExporter._libraryConfig = { isKnownTestsEnabled: true }
        ciVisibilityExporter.getKnownTests({}, (err) => {
          expect(err).not.to.be.null
          expect(scope.isDone()).to.be.true
          done()
        })
      })

      it('should accept gzip if the exporter is gzip compatible', (done) => {
        let requestHeaders = {}
        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/ci/libraries/tests')
          .reply(200, function () {
            requestHeaders = this.req.headers

            return zlib.gzipSync(JSON.stringify({
              data: {
                attributes: {
                  tests: {
                    jest: {
                      suite1: ['test1'],
                      suite2: ['test2']
                    }
                  }
                }
              }
            }))
          }, {
            'content-encoding': 'gzip'
          })

        const ciVisibilityExporter = new CiVisibilityExporter({ port })

        ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
        ciVisibilityExporter._libraryConfig = { isKnownTestsEnabled: true }
        ciVisibilityExporter._isGzipCompatible = true
        ciVisibilityExporter.getKnownTests({}, (err, knownTests) => {
          expect(err).to.be.null
          expect(knownTests).to.eql({
            jest: {
              suite1: ['test1'],
              suite2: ['test2']
            }
          })
          expect(scope.isDone()).to.be.true
          expect(requestHeaders['accept-encoding']).to.equal('gzip')
          done()
        })
      })

      it('should not accept gzip if the exporter is gzip incompatible', (done) => {
        let requestHeaders = {}
        const scope = nock(`http://localhost:${port}`)
          .post('/api/v2/ci/libraries/tests')
          .reply(200, function () {
            requestHeaders = this.req.headers

            return JSON.stringify({
              data: {
                attributes: {
                  tests: {
                    jest: {
                      suite1: ['test1'],
                      suite2: ['test2']
                    }
                  }
                }
              }
            })
          })

        const ciVisibilityExporter = new CiVisibilityExporter({ port })

        ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
        ciVisibilityExporter._libraryConfig = { isKnownTestsEnabled: true }
        ciVisibilityExporter._isGzipCompatible = false

        ciVisibilityExporter.getKnownTests({}, (err, knownTests) => {
          expect(err).to.be.null
          expect(knownTests).to.eql({
            jest: {
              suite1: ['test1'],
              suite2: ['test2']
            }
          })
          expect(scope.isDone()).to.be.true
          expect(requestHeaders['accept-encoding']).not.to.equal('gzip')
          done()
        })
      })
    })
  })

  describe('exportDiLogs', () => {
    context('is not initialized', () => {
      it('should do nothing', () => {
        const log = { message: 'log' }
        const ciVisibilityExporter = new CiVisibilityExporter({ port, isTestDynamicInstrumentationEnabled: true })
        ciVisibilityExporter.exportDiLogs(log)
        ciVisibilityExporter._export = sinon.spy()
        expect(ciVisibilityExporter._export).not.to.be.called
      })
    })

    context('is initialized but can not forward logs', () => {
      it('should do nothing', () => {
        const writer = {
          append: sinon.spy(),
          flush: sinon.spy(),
          setUrl: sinon.spy()
        }
        const log = { message: 'log' }
        const ciVisibilityExporter = new CiVisibilityExporter({ port, isTestDynamicInstrumentationEnabled: true })
        ciVisibilityExporter._isInitialized = true
        ciVisibilityExporter._logsWriter = writer
        ciVisibilityExporter._canForwardLogs = false
        ciVisibilityExporter.exportDiLogs(log)
        expect(ciVisibilityExporter._logsWriter.append).not.to.be.called
      })
    })

    context('is initialized and can forward logs', () => {
      it('should export formatted logs', () => {
        const writer = {
          append: sinon.spy(),
          flush: sinon.spy(),
          setUrl: sinon.spy()
        }
        const diLog = {
          message: 'log',
          debugger: {
            snapshot: {
              id: '1234',
              timestamp: 1234567890,
              probe: {
                id: '54321',
                version: '1',
                location: {
                  file: 'example.js',
                  lines: ['1']
                }
              },
              stack: [
                {
                  fileName: 'example.js',
                  function: 'sum',
                  lineNumber: 1
                }
              ],
              language: 'javascript'
            }
          }
        }
        const ciVisibilityExporter = new CiVisibilityExporter({
          env: 'ci',
          version: '1.0.0',
          port,
          isTestDynamicInstrumentationEnabled: true,
          service: 'my-service'
        })
        ciVisibilityExporter._isInitialized = true
        ciVisibilityExporter._logsWriter = writer
        ciVisibilityExporter._canForwardLogs = true
        ciVisibilityExporter.exportDiLogs(
          {
            'git.repository_url': 'https://github.com/datadog/dd-trace-js.git',
            'git.commit.sha': '1234'
          },
          diLog
        )
        expect(ciVisibilityExporter._logsWriter.append).to.be.calledWith(sinon.match({
          ddtags: 'git.repository_url:https://github.com/datadog/dd-trace-js.git,git.commit.sha:1234',
          level: 'error',
          ddsource: 'dd_debugger',
          service: 'my-service',
          dd: {
            service: 'my-service',
            env: 'ci',
            version: '1.0.0'
          },
          ...diLog
        }))
      })
    })
  })
})
