'use strict'
const fs = require('fs')
const path = require('path')

const { channel } = require('diagnostics_channel')
const nock = require('nock')
const semver = require('semver')
const msgpack = require('msgpack-lite')

const { ORIGIN_KEY, COMPONENT, ERROR_MESSAGE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const {
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_SOURCE_FILE,
  TEST_FRAMEWORK_VERSION,
  TEST_STATUS,
  CI_APP_ORIGIN,
  JEST_TEST_RUNNER,
  TEST_PARAMETERS,
  TEST_CODE_OWNERS,
  LIBRARY_VERSION,
  TEST_COMMAND,
  TEST_SUITE_ID,
  TEST_SESSION_ID
} = require('../../dd-trace/src/plugins/util/test')

const { version: ddTraceVersion } = require('../../../package.json')

const gitMetadataUploadFinishCh = channel('ci:git-metadata-upload:finish')

/**
 * The assertion timeout needs to be less than the test timeout,
 * otherwise failing tests will always fail due to a timeout,
 * which is less useful than having an assertion error message.
 */
const assertionTimeout = 15000
const testTimeout = 20000

describe('Plugin', function () {
  let jestExecutable
  let jestCommonOptions

  this.timeout(testTimeout)

  withVersions('jest', ['jest-environment-node', 'jest-environment-jsdom'], (version, moduleName) => {
    afterEach(() => {
      delete process.env.DD_CIVISIBILITY_ITR_ENABLED
      delete process.env.DD_API_KEY
      const jestTestFile = fs.readdirSync(__dirname).filter(name => name.startsWith('jest-'))
      jestTestFile.forEach((testFile) => {
        delete require.cache[require.resolve(path.join(__dirname, testFile))]
      })
      delete require.cache[require.resolve(path.join(__dirname, 'env.js'))]
      delete global._ddtrace
      nock.cleanAll()
      return agent.close({ ritmReset: false, wipe: true })
    })
    beforeEach(function () {
      // for http integration tests
      nock('http://test:123')
        .get('/')
        .reply(200, 'OK')

      const loadArguments = [['jest', 'http']]

      const isAgentlessTest = this.currentTest.parent.title === 'agentless'

      // we need the ci visibility init for the coverage test
      if (isAgentlessTest) {
        process.env.DD_API_KEY = 'key'
        process.env.DD_APP_KEY = 'app-key'
        process.env.DD_ENV = 'ci'
        process.env.DD_CIVISIBILITY_ITR_ENABLED = 1
        process.env.DD_SITE = 'datad0g.com'
        loadArguments.push({ service: 'test', isAgentlessEnabled: true, isIntelligentTestRunnerEnabled: true })
        loadArguments.push({ experimental: { exporter: 'datadog' } })
      } else {
        loadArguments.push({ service: 'test' })
      }

      return agent.load(...loadArguments).then(() => {
        global.__libraryName__ = moduleName
        global.__libraryVersion__ = version
        jestExecutable = require(`../../../versions/jest@${version}`).get()

        jestCommonOptions = {
          projects: [__dirname],
          testPathIgnorePatterns: ['/node_modules/'],
          coverageReporters: ['none'],
          reporters: [],
          silent: true,
          testEnvironment: path.join(__dirname, 'env.js'),
          testRunner: require(`../../../versions/jest-circus@${version}`).getPath('jest-circus/runner'),
          cache: false,
          maxWorkers: '50%'
        }
      })
    })
    describe('jest with jest-circus', () => {
      it('should create test spans for sync, async, integration, parameterized and retried tests', (done) => {
        const tests = [
          {
            name: 'jest-test-suite tracer and active span are available',
            status: 'pass',
            extraTags: { 'test.add.stuff': 'stuff' }
          },
          { name: 'jest-test-suite done', status: 'pass' },
          { name: 'jest-test-suite done fail', status: 'fail' },
          { name: 'jest-test-suite done fail uncaught', status: 'fail' },
          { name: 'jest-test-suite can do integration http', status: 'pass' },
          {
            name: 'jest-test-suite can do parameterized test',
            status: 'pass',
            parameters: { arguments: [1, 2, 3], metadata: {} }
          },
          {
            name: 'jest-test-suite can do parameterized test',
            status: 'pass',
            parameters: { arguments: [2, 3, 5], metadata: {} }
          },
          { name: 'jest-test-suite promise passes', status: 'pass' },
          { name: 'jest-test-suite promise fails', status: 'fail' },
          { name: 'jest-test-suite timeout', status: 'fail', error: 'dsd timeout' }, // will error
          { name: 'jest-test-suite passes', status: 'pass' },
          { name: 'jest-test-suite fails', status: 'fail' },
          { name: 'jest-test-suite does not crash with missing stack', status: 'fail' },
          { name: 'jest-test-suite skips', status: 'skip' },
          { name: 'jest-test-suite skips todo', status: 'skip' },
          { name: 'jest-circus-test-retry can retry', status: 'fail' },
          { name: 'jest-circus-test-retry can retry', status: 'fail' },
          { name: 'jest-circus-test-retry can retry', status: 'pass' }
        ]

        const assertionPromises = tests.map(({ name, status, error, parameters, extraTags }) => {
          return agent.use(trace => {
            const testSpan = trace[0][0]
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(testSpan.meta).to.contain({
              language: 'javascript',
              service: 'test',
              [ORIGIN_KEY]: CI_APP_ORIGIN,
              [TEST_FRAMEWORK]: 'jest',
              [TEST_NAME]: name,
              [TEST_STATUS]: status,
              [TEST_SUITE]: 'packages/datadog-plugin-jest/test/jest-test.js',
              [TEST_SOURCE_FILE]: 'packages/datadog-plugin-jest/test/jest-test.js',
              [TEST_TYPE]: 'test',
              [JEST_TEST_RUNNER]: 'jest-circus',
              [TEST_CODE_OWNERS]: JSON.stringify(['@DataDog/dd-trace-js']), // reads from dd-trace-js
              [LIBRARY_VERSION]: ddTraceVersion,
              [COMPONENT]: 'jest'
            })
            if (extraTags) {
              expect(testSpan.meta).to.contain(extraTags)
            }
            if (error) {
              expect(testSpan.meta[ERROR_MESSAGE]).to.include(error)
            }
            if (name === 'jest-test-suite can do integration http') {
              const httpSpan = trace[0].find(span => span.name === 'http.request')
              expect(httpSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
              expect(httpSpan.meta['http.url']).to.equal('http://test:123/')
              expect(httpSpan.parent_id.toString()).to.equal(testSpan.span_id.toString())
            }
            if (parameters) {
              expect(testSpan.meta[TEST_PARAMETERS]).to.equal(JSON.stringify(parameters))
            }
            expect(testSpan.type).to.equal('test')
            expect(testSpan.name).to.equal('jest.test')
            expect(testSpan.service).to.equal('test')
            expect(testSpan.resource).to.equal(`packages/datadog-plugin-jest/test/jest-test.js.${name}`)
            expect(testSpan.meta[TEST_FRAMEWORK_VERSION]).not.to.be.undefined
          }, {
            timeoutMs: testTimeout,
            traceMatch: (traces) => {
              const spans = traces.flatMap(span => span)
              return spans.find(span => span.meta[TEST_NAME] === name)
            }
          })
        })

        Promise.all(assertionPromises).then(() => done()).catch(done)

        const options = {
          ...jestCommonOptions,
          testRegex: 'jest-test.js'
        }

        jestExecutable.runCLI(
          options,
          options.projects
        )
      })

      it('should detect an error in hooks', (done) => {
        const tests = [
          { name: 'jest-hook-failure will not run', error: 'hey, hook error before' },
          { name: 'jest-hook-failure-after will not run', error: 'hey, hook error after' }
        ]
        const assertionPromises = tests.map(({ name, error }) => {
          return agent.use(trace => {
            const testSpan = trace[0][0]
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(testSpan.meta).to.contain({
              language: 'javascript',
              service: 'test',
              [ORIGIN_KEY]: CI_APP_ORIGIN,
              [TEST_FRAMEWORK]: 'jest',
              [TEST_NAME]: name,
              [TEST_STATUS]: 'fail',
              [TEST_SUITE]: 'packages/datadog-plugin-jest/test/jest-hook-failure.js',
              [TEST_SOURCE_FILE]: 'packages/datadog-plugin-jest/test/jest-hook-failure.js',
              [TEST_TYPE]: 'test',
              [JEST_TEST_RUNNER]: 'jest-circus',
              [COMPONENT]: 'jest'
            })
            expect(testSpan.meta[ERROR_MESSAGE]).to.equal(error)
            expect(testSpan.type).to.equal('test')
            expect(testSpan.name).to.equal('jest.test')
            expect(testSpan.service).to.equal('test')
            expect(testSpan.resource).to.equal(
              `packages/datadog-plugin-jest/test/jest-hook-failure.js.${name}`
            )
            expect(testSpan.meta[TEST_FRAMEWORK_VERSION]).not.to.be.undefined
          }, { timeoutMs: assertionTimeout })
        })

        Promise.all(assertionPromises).then(() => done()).catch(done)

        const options = {
          ...jestCommonOptions,
          testRegex: 'jest-hook-failure.js'
        }

        jestExecutable.runCLI(
          options,
          options.projects
        )
      })

      it('should work with focused tests', (done) => {
        const tests = [
          { name: 'jest-test-focused will be skipped', status: 'skip' },
          { name: 'jest-test-focused-2 will be skipped too', status: 'skip' },
          { name: 'jest-test-focused can do focused test', status: 'pass' }
        ]

        const assertionPromises = tests.map(({ name, status }) => {
          return agent.use(trace => {
            const testSpan = trace[0].find(span => span.type === 'test')
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(testSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
            expect(testSpan.meta).to.contain({
              language: 'javascript',
              service: 'test',
              [TEST_NAME]: name,
              [TEST_STATUS]: status,
              [TEST_FRAMEWORK]: 'jest',
              [TEST_SUITE]: 'packages/datadog-plugin-jest/test/jest-focus.js',
              [TEST_SOURCE_FILE]: 'packages/datadog-plugin-jest/test/jest-focus.js',
              [COMPONENT]: 'jest'
            })
          }, { timeoutMs: assertionTimeout })
        })

        Promise.all(assertionPromises).then(() => done()).catch(done)

        const options = {
          ...jestCommonOptions,
          testRegex: 'jest-focus.js'
        }

        jestExecutable.runCLI(
          options,
          options.projects
        )
      })

      // option available from 26.5.0:
      // https://github.com/facebook/jest/blob/7f2731ef8bebac7f226cfc0d2446854603a557a9/CHANGELOG.md#2650
      if (semver.intersects(version, '>=26.5.0')) {
        it('does not crash when injectGlobals is false', (done) => {
          agent.use(trace => {
            const testSpan = trace[0].find(span => span.type === 'test')
            expect(testSpan.meta).to.contain({
              [TEST_NAME]: 'jest-inject-globals will be run',
              [TEST_STATUS]: 'pass',
              [TEST_SUITE]: 'packages/datadog-plugin-jest/test/jest-inject-globals.js'
            })
          }, { timeoutMs: assertionTimeout }).then(() => done()).catch(done)

          const options = {
            ...jestCommonOptions,
            testRegex: 'jest-inject-globals.js',
            injectGlobals: false
          }

          jestExecutable.runCLI(
            options,
            options.projects
          )
        })
      }

      describe('agentless', () => {
        it('can report code coverage', function (done) {
          nock('https://api.datad0g.com/')
            .post('/api/v2/libraries/tests/services/setting')
            .reply(200, JSON.stringify({
              data: {
                attributes: {
                  code_coverage: true,
                  tests_skipping: true
                }
              }
            }))

          nock(`http://127.0.0.1:${agent.server.address().port}`)
            .post('/api/v2/citestcov')
            .reply(202, function () {
              const contentTypeHeader = this.req.headers['content-type']
              const contentDisposition = this.req.requestBodyBuffers[1].toString()
              const eventContentDisposition = this.req.requestBodyBuffers[6].toString()
              const eventPayload = this.req.requestBodyBuffers[8].toString()
              const coveragePayload = msgpack.decode(this.req.requestBodyBuffers[3])

              expect(contentTypeHeader).to.contain('multipart/form-data')
              expect(coveragePayload.version).to.equal(1)
              const coverageFiles = coveragePayload.files.map(file => file.filename)

              expect(coverageFiles)
                .to.include('packages/datadog-plugin-jest/test/sum-coverage-test.js')
              expect(coverageFiles)
                .to.include('packages/datadog-plugin-jest/test/jest-coverage.js')
              expect(contentDisposition).to.contain(
                'Content-Disposition: form-data; name="coverage1"; filename="coverage1.msgpack"'
              )
              expect(eventContentDisposition).to.contain(
                'Content-Disposition: form-data; name="event"; filename="event.json"'
              )
              expect(eventPayload).to.equal(JSON.stringify({ dummy: true }))
              done()
            })

          const options = {
            ...jestCommonOptions,
            testRegex: 'jest-coverage.js',
            coverage: true,
            runInBand: true
          }

          jestExecutable.runCLI(
            options,
            options.projects
          )
          gitMetadataUploadFinishCh.publish()
        })
        it('does not report code coverage if not enabled by the API', function (done) {
          nock('https://api.datad0g.com/')
            .post('/api/v2/libraries/tests/services/setting')
            .reply(200, JSON.stringify({
              data: {
                attributes: {
                  code_coverage: false,
                  tests_skipping: true
                }
              }
            }))

          const scope = nock(`http://127.0.0.1:${agent.server.address().port}`)
            .post('/api/v2/citestcov')
            .reply(202, function () {
              done(new Error('Code coverage should not be uploaded when not enabled'))
            })

          const options = {
            ...jestCommonOptions,
            testRegex: 'jest-coverage.js',
            coverage: true
          }

          jestExecutable.runCLI(
            options,
            options.projects
          ).then(() => {
            expect(scope.isDone()).to.be.false
            done()
          })
          gitMetadataUploadFinishCh.publish()
        })
        it('should create spans for the test session and test suite', (done) => {
          const events = [
            { type: 'test_session_end', status: 'pass' },
            {
              type: 'test_suite_end',
              status: 'pass',
              suite: 'packages/datadog-plugin-jest/test/jest-test-suite.js'
            },
            {
              name: 'jest-test-suite-visibility works',
              suite: 'packages/datadog-plugin-jest/test/jest-test-suite.js',
              status: 'pass',
              type: 'test'
            }
          ]

          const assertionPromises = events.map(({ name, suite, status, type }) => {
            return agent.use(agentlessPayload => {
              const { events } = agentlessPayload
              const span = events.find(event => event.type === type).content
              expect(span.meta[TEST_STATUS]).to.equal(status)
              expect(span.meta[COMPONENT]).to.equal('jest')
              if (type === 'test_session_end') {
                expect(span.meta[TEST_COMMAND]).not.to.equal(undefined)
                expect(span[TEST_SUITE_ID]).to.equal(undefined)
                expect(span[TEST_SESSION_ID]).not.to.equal(undefined)
              }
              if (type === 'test_suite_end') {
                expect(span.meta[TEST_SUITE]).to.equal(suite)
                expect(span.meta[TEST_COMMAND]).not.to.equal(undefined)
                expect(span[TEST_SUITE_ID]).not.to.equal(undefined)
                expect(span[TEST_SESSION_ID]).not.to.equal(undefined)
              }
              if (type === 'test') {
                expect(span.meta[TEST_SUITE]).to.equal(suite)
                expect(span.meta[TEST_NAME]).to.equal(name)
                expect(span.meta[TEST_COMMAND]).not.to.equal(undefined)
                expect(span[TEST_SUITE_ID]).not.to.equal(undefined)
                expect(span[TEST_SESSION_ID]).not.to.equal(undefined)
              }
            }, { timeoutMs: assertionTimeout })
          })

          Promise.all(assertionPromises).then(() => done()).catch(done)

          const options = {
            ...jestCommonOptions,
            testRegex: 'jest-test-suite.js'
          }

          jestExecutable.runCLI(
            options,
            options.projects
          )
          gitMetadataUploadFinishCh.publish()
        })
        it('can skip suites received by the intelligent test runner API', (done) => {
          nock('https://api.datad0g.com/')
            .post('/api/v2/libraries/tests/services/setting')
            .reply(200, JSON.stringify({
              data: {
                attributes: {
                  code_coverage: true,
                  tests_skipping: true
                }
              }
            }))

          const scope = nock('https://api.datad0g.com/')
            .post('/api/v2/ci/tests/skippable')
            .reply(200, JSON.stringify({
              data: [{
                type: 'suite',
                attributes: {
                  suite: 'packages/datadog-plugin-jest/test/jest-itr-skip.js'
                }
              }]
            }))

          agent.use(agentlessPayload => {
            const { events: [{ content: testSpan }] } = agentlessPayload
            expect(testSpan.meta).to.contain({
              [TEST_NAME]: 'jest-itr-pass will be run',
              [TEST_STATUS]: 'pass',
              [TEST_SUITE]: 'packages/datadog-plugin-jest/test/jest-itr-pass.js'
            })
          }, { timeoutMs: assertionTimeout }).then(() => {
            expect(scope.isDone()).to.be.true
            done()
          }).catch(done)

          const options = {
            ...jestCommonOptions,
            testRegex: /jest-itr-/
          }

          jestExecutable.runCLI(
            options,
            options.projects
          )
          gitMetadataUploadFinishCh.publish()
        })
        it('does not skip tests if git metadata is not uploaded', function (done) {
          nock('https://api.datad0g.com/')
            .post('/api/v2/libraries/tests/services/setting')
            .reply(200, JSON.stringify({
              data: {
                attributes: {
                  code_coverage: true,
                  tests_skipping: true
                }
              }
            }))

          nock('https://api.datad0g.com/')
            .post('/api/v2/ci/tests/skippable')
            .reply(200, JSON.stringify({
              data: [{
                type: 'suite',
                attributes: {
                  suite: 'packages/datadog-plugin-jest/test/jest-itr-skip.js'
                }
              }]
            }))

          const tests = [
            {
              name: 'jest-itr-skip will be skipped through ITR',
              status: 'pass',
              suite: 'packages/datadog-plugin-jest/test/jest-itr-skip.js'
            },
            {
              name: 'jest-itr-pass will be run',
              status: 'pass',
              suite: 'packages/datadog-plugin-jest/test/jest-itr-pass.js'
            }
          ]
          const assertionPromises = tests.map(({ name, status, suite }) => {
            return agent.use(agentlessPayload => {
              const { events: [{ content: testSpan }] } = agentlessPayload
              expect(testSpan.meta).to.contain({
                [COMPONENT]: 'jest',
                [TEST_NAME]: name,
                [TEST_STATUS]: status,
                [TEST_SUITE]: suite
              })
            }, { timeoutMs: assertionTimeout })
          })

          Promise.all(assertionPromises).then(() => done()).catch(done)

          const options = {
            ...jestCommonOptions,
            testRegex: /jest-itr-/,
            runInBand: true
          }

          jestExecutable.runCLI(
            options,
            options.projects
          )
          gitMetadataUploadFinishCh.publish(new Error('error uploading'))
        })
        it('does not skip tests if test skipping is disabled via API', (done) => {
          nock('https://api.datad0g.com/')
            .post('/api/v2/libraries/tests/services/setting')
            .reply(200, JSON.stringify({
              data: {
                attributes: {
                  code_coverage: true,
                  tests_skipping: false
                }
              }
            }))

          nock('https://api.datad0g.com/')
            .post('/api/v2/ci/tests/skippable')
            .reply(200, JSON.stringify({
              data: [{
                type: 'suite',
                attributes: {
                  suite: 'packages/datadog-plugin-jest/test/jest-itr-skip.js'
                }
              }]
            }))

          const tests = [
            {
              name: 'jest-itr-skip will be skipped through ITR',
              status: 'pass',
              suite: 'packages/datadog-plugin-jest/test/jest-itr-skip.js'
            },
            {
              name: 'jest-itr-pass will be run',
              status: 'pass',
              suite: 'packages/datadog-plugin-jest/test/jest-itr-pass.js'
            }
          ]
          const assertionPromises = tests.map(({ name, status, suite }) => {
            return agent.use(agentlessPayload => {
              const { events: [{ content: testSpan }] } = agentlessPayload
              expect(testSpan.meta).to.contain({
                [COMPONENT]: 'jest',
                [TEST_NAME]: name,
                [TEST_STATUS]: status,
                [TEST_SUITE]: suite
              })
            }, { timeoutMs: assertionTimeout })
          })

          Promise.all(assertionPromises).then(() => done()).catch(done)

          const options = {
            ...jestCommonOptions,
            testRegex: /jest-itr-/,
            runInBand: true
          }

          jestExecutable.runCLI(
            options,
            options.projects
          )
          gitMetadataUploadFinishCh.publish()
        })
        it('reports code coverage also when there are suites to skip', (done) => {
          // trick to check what jest prints in the stdout
          let buffer = ''
          const oldStdout = process.stdout.write
          process.stdout.write = (input) => {
            buffer += input
          }

          nock('https://api.datad0g.com/')
            .post('/api/v2/libraries/tests/services/setting')
            .reply(200, JSON.stringify({
              data: {
                attributes: {
                  code_coverage: true,
                  tests_skipping: true
                }
              }
            }))

          nock('https://api.datad0g.com/')
            .post('/api/v2/ci/tests/skippable')
            .reply(200, JSON.stringify({
              data: [{
                type: 'suite',
                attributes: {
                  suite: 'packages/datadog-plugin-jest/test/jest-itr-skip.js'
                }
              }]
            }))

          nock(`http://127.0.0.1:${agent.server.address().port}`)
            .post('/api/v2/citestcov')
            .reply(202, function () {
              const contentTypeHeader = this.req.headers['content-type']
              const contentDisposition = this.req.requestBodyBuffers[1].toString()
              const eventContentDisposition = this.req.requestBodyBuffers[6].toString()
              const eventPayload = this.req.requestBodyBuffers[8].toString()
              const coveragePayload = msgpack.decode(this.req.requestBodyBuffers[3])

              expect(contentTypeHeader).to.contain('multipart/form-data')
              expect(coveragePayload.version).to.equal(1)
              const coverageFiles = coveragePayload.files.map(file => file.filename)

              expect(coverageFiles)
                .to.include('packages/datadog-plugin-jest/test/sum-coverage-test.js')
              expect(coverageFiles)
                .to.include('packages/datadog-plugin-jest/test/jest-itr-pass.js')
              expect(contentDisposition).to.contain(
                'Content-Disposition: form-data; name="coverage1"; filename="coverage1.msgpack"'
              )
              expect(eventContentDisposition).to.contain(
                'Content-Disposition: form-data; name="event"; filename="event.json"'
              )
              expect(eventPayload).to.equal(JSON.stringify({ dummy: true }))
              process.stdout.write = oldStdout
              expect(buffer).not.to.include('Coverage summary')
              done()
            })
            .post('/api/v2/citestcov')
            .reply(202, function () {
              throw new Error('There should only be a single coverage payload')
            })

          const options = {
            ...jestCommonOptions,
            testRegex: /jest-itr-/,
            coverage: true
          }

          jestExecutable.runCLI(
            options,
            options.projects
          )
          gitMetadataUploadFinishCh.publish()
        })
      })
    })
  })
})
