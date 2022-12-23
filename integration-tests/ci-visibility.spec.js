'use strict'

const { fork, exec } = require('child_process')
const path = require('path')

const { assert } = require('chai')
const semver = require('semver')
const getPort = require('get-port')

const {
  createSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig
} = require('./helpers')
const { FakeCiVisIntake } = require('./ci-visibility-intake')

const {
  TEST_SESSION_ITR_CODE_COVERAGE_ENABLED,
  TEST_SESSION_ITR_SKIPPING_ENABLED,
  TEST_ITR_TESTS_SKIPPED
} = require('../packages/dd-trace/src/plugins/util/test')

// TODO: remove when 2.x support is removed.
// This is done because newest versions of mocha and jest do not support node@12
const isOldNode = semver.satisfies(process.version, '<=12')

const testFrameworks = [
  {
    name: 'mocha',
    dependencies: [isOldNode ? 'mocha@9' : 'mocha', 'chai', 'nyc'],
    testFile: 'ci-visibility/run-mocha.js',
    expectedStdout: '2 passing',
    expectedCoverageFiles: [
      'ci-visibility/run-mocha.js',
      'ci-visibility/test/sum.js',
      'ci-visibility/test/ci-visibility-test.js',
      'ci-visibility/test/ci-visibility-test-2.js'
    ],
    runTestsWithCoverageCommand: './node_modules/nyc/bin/nyc.js node ./ci-visibility/run-mocha.js'
  },
  {
    name: 'jest',
    dependencies: [isOldNode ? 'jest@28' : 'jest', 'chai'],
    testFile: 'ci-visibility/run-jest.js',
    expectedStdout: 'Test Suites: 2 passed',
    expectedCoverageFiles: [
      'ci-visibility/test/sum.js',
      'ci-visibility/test/ci-visibility-test.js',
      'ci-visibility/test/ci-visibility-test-2.js'
    ],
    runTestsWithCoverageCommand: 'node ./ci-visibility/run-jest.js'
  }
]

testFrameworks.forEach(({
  name,
  dependencies,
  testFile,
  expectedStdout,
  expectedCoverageFiles,
  runTestsWithCoverageCommand
}) => {
  describe(name, () => {
    let receiver
    let childProcess
    let sandbox
    let cwd
    let startupTestFile
    let testOutput = ''

    before(async () => {
      sandbox = await createSandbox(dependencies, true)
      cwd = sandbox.folder
      startupTestFile = path.join(cwd, testFile)
    })

    after(async () => {
      await sandbox.remove()
    })

    beforeEach(async function () {
      const port = await getPort()
      receiver = await new FakeCiVisIntake(port).start()
    })

    afterEach(async () => {
      childProcess.kill()
      testOutput = ''
      await receiver.stop()
    })

    it('can run tests and report spans', (done) => {
      receiver.setInfoResponse({ endpoints: [] })
      receiver.payloadReceived(({ url }) => url === '/v0.4/traces').then(({ payload }) => {
        const testSpans = payload.flatMap(trace => trace)
        const resourceNames = testSpans.map(span => span.resource)

        assert.includeMembers(resourceNames,
          [
            'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests',
            'ci-visibility/test/ci-visibility-test-2.js.ci visibility 2 can report tests 2'
          ]
        )
        const areAllTestSpans = testSpans.every(span => span.name === `${name}.test`)
        assert.isTrue(areAllTestSpans)
        assert.include(testOutput, expectedStdout)
        done()
      })

      childProcess = fork(startupTestFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: receiver.port,
          NODE_OPTIONS: '-r dd-trace/ci/init'
        },
        stdio: 'pipe'
      })
      childProcess.stdout.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
    })
    const envVarSettings = ['DD_TRACING_ENABLED', 'DD_TRACE_ENABLED']

    envVarSettings.forEach(envVar => {
      context(`when ${envVar}=false`, () => {
        it('does not report spans but still runs tests', (done) => {
          receiver.assertMessageReceived(() => {
            done(new Error('Should not create spans'))
          })

          childProcess = fork(startupTestFile, {
            cwd,
            env: {
              DD_TRACE_AGENT_PORT: receiver.port,
              NODE_OPTIONS: '-r dd-trace/ci/init',
              [envVar]: 'false'
            },
            stdio: 'pipe'
          })
          childProcess.stdout.on('data', (chunk) => {
            testOutput += chunk.toString()
          })
          childProcess.stderr.on('data', (chunk) => {
            testOutput += chunk.toString()
          })
          childProcess.on('message', () => {
            assert.include(testOutput, expectedStdout)
            done()
          })
        })
      })
    })

    describe('agentless', () => {
      it('does not init if DD_API_KEY is not set', (done) => {
        receiver.assertMessageReceived(() => {
          done(new Error('Should not create spans'))
        })
        childProcess = fork(startupTestFile, {
          cwd,
          env: {
            DD_CIVISIBILITY_AGENTLESS_ENABLED: 1,
            NODE_OPTIONS: '-r dd-trace/ci/init'
          },
          stdio: 'pipe'
        })
        childProcess.stdout.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.on('message', () => {
          assert.include(testOutput, expectedStdout)
          assert.include(testOutput, 'DD_CIVISIBILITY_AGENTLESS_ENABLED is set, ' +
            'but neither DD_API_KEY nor DATADOG_API_KEY are set in your environment, ' +
            'so dd-trace will not be initialized.'
          )
          done()
        })
      })
      it('can report git metadata', (done) => {
        const searchCommitsRequestPromise = receiver.payloadReceived(
          ({ url }) => url === '/api/v2/git/repository/search_commits'
        )
        const packfileRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/git/repository/packfile')
        const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle')

        Promise.all([
          searchCommitsRequestPromise,
          packfileRequestPromise,
          eventsRequestPromise
        ]).then(([searchCommitRequest, packfileRequest, eventsRequest]) => {
          assert.propertyVal(searchCommitRequest.headers, 'dd-api-key', '1')
          assert.propertyVal(packfileRequest.headers, 'dd-api-key', '1')

          const eventTypes = eventsRequest.payload.events.map(event => event.type)
          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_session_end'])
          const numSuites = eventTypes.reduce(
            (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
          )
          assert.equal(numSuites, 2)

          done()
        }).catch(done)

        childProcess = fork(startupTestFile, {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
          stdio: 'pipe'
        })
      })
      it('can report code coverage', (done) => {
        const itrConfigRequestPromise = receiver.payloadReceived(
          ({ url }) => url === '/api/v2/libraries/tests/services/setting'
        )
        const codeCovRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcov')
        const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle')

        Promise.all([
          itrConfigRequestPromise,
          codeCovRequestPromise,
          eventsRequestPromise
        ]).then(([itrConfigRequest, codeCovRequest, eventsRequest]) => {
          assert.propertyVal(itrConfigRequest.headers, 'dd-api-key', '1')
          assert.propertyVal(itrConfigRequest.headers, 'dd-application-key', '1')

          const [coveragePayload] = codeCovRequest.payload
          assert.propertyVal(codeCovRequest.headers, 'dd-api-key', '1')

          assert.propertyVal(coveragePayload, 'name', 'coverage1')
          assert.propertyVal(coveragePayload, 'filename', 'coverage1.msgpack')
          assert.propertyVal(coveragePayload, 'type', 'application/msgpack')
          assert.include(coveragePayload.content, {
            version: 1
          })
          const allCoverageFiles = codeCovRequest.payload
            .flatMap(coverage => coverage.content.files)
            .map(file => file.filename)

          assert.includeMembers(allCoverageFiles, expectedCoverageFiles)
          assert.exists(coveragePayload.content.span_id)
          assert.exists(coveragePayload.content.trace_id)

          const eventTypes = eventsRequest.payload.events.map(event => event.type)
          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_session_end'])
          const numSuites = eventTypes.reduce(
            (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
          )
          assert.equal(numSuites, 2)
          done()
        }).catch(done)

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: getCiVisAgentlessConfig(receiver.port),
            stdio: 'inherit'
          }
        )
      })
      it('does not report code coverage if disabled by the API', (done) => {
        receiver.setSettings({
          code_coverage: false,
          tests_skipping: false
        })

        receiver.assertPayloadReceived(() => {
          const error = new Error('it should not report code coverage')
          done(error)
        }, ({ url }) => url === '/api/v2/citestcov')

        receiver.assertPayloadReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'dd-api-key', '1')
          const eventTypes = payload.events.map(event => event.type)
          assert.includeMembers(eventTypes, ['test', 'test_session_end', 'test_suite_end'])
          const testSession = payload.events.find(event => event.type === 'test_session_end').content
          assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'false')
          assert.propertyVal(testSession.meta, TEST_SESSION_ITR_CODE_COVERAGE_ENABLED, 'false')
          assert.propertyVal(testSession.meta, TEST_SESSION_ITR_SKIPPING_ENABLED, 'false')
        }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: getCiVisAgentlessConfig(receiver.port),
            stdio: 'inherit'
          }
        )
      })
      it('can skip suites received by the intelligent test runner API and still reports code coverage', (done) => {
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/test/ci-visibility-test.js'
          }
        }])

        const skippableRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/ci/tests/skippable')
        const coverageRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcov')
        const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle')

        Promise.all([
          skippableRequestPromise,
          coverageRequestPromise,
          eventsRequestPromise
        ]).then(([skippableRequest, coverageRequest, eventsRequest]) => {
          assert.propertyVal(skippableRequest.headers, 'dd-api-key', '1')
          assert.propertyVal(skippableRequest.headers, 'dd-application-key', '1')
          const [coveragePayload] = coverageRequest.payload
          assert.propertyVal(coverageRequest.headers, 'dd-api-key', '1')
          assert.propertyVal(coveragePayload, 'name', 'coverage1')
          assert.propertyVal(coveragePayload, 'filename', 'coverage1.msgpack')
          assert.propertyVal(coveragePayload, 'type', 'application/msgpack')

          assert.propertyVal(eventsRequest.headers, 'dd-api-key', '1')
          const eventTypes = eventsRequest.payload.events.map(event => event.type)
          const skippedTest = eventsRequest.payload.events.find(event =>
            event.content.resource === 'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests'
          )
          assert.notExists(skippedTest)
          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_session_end'])
          const numSuites = eventTypes.reduce(
            (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
          )
          assert.equal(numSuites, 1)
          const testSession = eventsRequest.payload.events.find(event => event.type === 'test_session_end').content
          assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'true')
          assert.propertyVal(testSession.meta, TEST_SESSION_ITR_CODE_COVERAGE_ENABLED, 'true')
          assert.propertyVal(testSession.meta, TEST_SESSION_ITR_SKIPPING_ENABLED, 'true')
          done()
        })
        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: getCiVisAgentlessConfig(receiver.port),
            stdio: 'inherit'
          }
        )
      })
      it('does not skip tests if git metadata upload fails', (done) => {
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/test/ci-visibility-test.js'
          }
        }])

        receiver.setGitUploadStatus(404)

        receiver.assertPayloadReceived(() => {
          const error = new Error('should not request skippable')
          done(error)
        }, ({ url }) => url === '/api/v2/ci/tests/skippable')

        receiver.assertPayloadReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'dd-api-key', '1')
          const eventTypes = payload.events.map(event => event.type)
          // because they are not skipped
          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_session_end'])
          const numSuites = eventTypes.reduce(
            (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
          )
          assert.equal(numSuites, 2)
          const testSession = payload.events.find(event => event.type === 'test_session_end').content
          assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'false')
          assert.propertyVal(testSession.meta, TEST_SESSION_ITR_CODE_COVERAGE_ENABLED, 'true')
          assert.propertyVal(testSession.meta, TEST_SESSION_ITR_SKIPPING_ENABLED, 'true')
        }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: getCiVisAgentlessConfig(receiver.port),
            stdio: 'inherit'
          }
        )
      })
      it('does not skip tests if test skipping is disabled by the API', (done) => {
        receiver.setSettings({
          code_coverage: true,
          tests_skipping: false
        })

        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/test/ci-visibility-test.js'
          }
        }])

        receiver.assertPayloadReceived(() => {
          const error = new Error('should not request skippable')
          done(error)
        }, ({ url }) => url === '/api/v2/ci/tests/skippable')

        receiver.assertPayloadReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'dd-api-key', '1')
          const eventTypes = payload.events.map(event => event.type)
          // because they are not skipped
          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_session_end'])
          const numSuites = eventTypes.reduce(
            (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
          )
          assert.equal(numSuites, 2)
        }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: getCiVisAgentlessConfig(receiver.port),
            stdio: 'inherit'
          }
        )
      })
    })

    describe('evp proxy', () => {
      context('if the agent is not event platform proxy compatible', () => {
        it('does not do any intelligent test runner request', (done) => {
          receiver.setInfoResponse({ endpoints: [] })

          receiver.assertPayloadReceived(() => {
            const error = new Error('should not request search_commits')
            done(error)
          }, ({ url }) => url === '/evp_proxy/v2/api/v2/git/repository/search_commits')
          receiver.assertPayloadReceived(() => {
            const error = new Error('should not request search_commits')
            done(error)
          }, ({ url }) => url === '/api/v2/git/repository/search_commits')
          receiver.assertPayloadReceived(() => {
            const error = new Error('should not request setting')
            done(error)
          }, ({ url }) => url === '/api/v2/libraries/tests/services/setting')
          receiver.assertPayloadReceived(() => {
            const error = new Error('should not request setting')
            done(error)
          }, ({ url }) => url === '/evp_proxy/v2/api/v2/libraries/tests/services/setting')

          receiver.assertPayloadReceived(({ payload }) => {
            const testSpans = payload.flatMap(trace => trace)
            const resourceNames = testSpans.map(span => span.resource)

            assert.includeMembers(resourceNames,
              [
                'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests',
                'ci-visibility/test/ci-visibility-test-2.js.ci visibility 2 can report tests 2'
              ]
            )
          }, ({ url }) => url === '/v0.4/traces').then(() => done()).catch(done)

          childProcess = fork(startupTestFile, {
            cwd,
            env: getCiVisEvpProxyConfig(receiver.port),
            stdio: 'pipe'
          })
        })
      })
      it('can report git metadata', (done) => {
        const infoRequestPromise = receiver.payloadReceived(({ url }) => url === '/info')
        const searchCommitsRequestPromise = receiver.payloadReceived(
          ({ url }) => url === '/evp_proxy/v2/api/v2/git/repository/search_commits'
        )
        const packFileRequestPromise = receiver.payloadReceived(
          ({ url }) => url === '/evp_proxy/v2/api/v2/git/repository/packfile'
        )
        const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/evp_proxy/v2/api/v2/citestcycle')

        Promise.all([
          infoRequestPromise,
          searchCommitsRequestPromise,
          packFileRequestPromise,
          eventsRequestPromise
        ]).then(([infoRequest, searchCommitsRequest, packfileRequest, eventsRequest]) => {
          assert.notProperty(infoRequest.headers, 'dd-api-key')

          assert.notProperty(searchCommitsRequest.headers, 'dd-api-key')
          assert.propertyVal(searchCommitsRequest.headers, 'x-datadog-evp-subdomain', 'api')

          assert.notProperty(packfileRequest.headers, 'dd-api-key')
          assert.propertyVal(packfileRequest.headers, 'x-datadog-evp-subdomain', 'api')

          const eventTypes = eventsRequest.payload.events.map(event => event.type)
          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_session_end'])
          const numSuites = eventTypes.reduce(
            (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
          )
          assert.equal(numSuites, 2)
          done()
        })

        childProcess = fork(startupTestFile, {
          cwd,
          env: getCiVisEvpProxyConfig(receiver.port),
          stdio: 'pipe'
        })
      })
      it('can report code coverage', (done) => {
        const itrConfigRequestPromise = receiver.payloadReceived(
          ({ url }) => url === '/evp_proxy/v2/api/v2/libraries/tests/services/setting'
        )
        const codeCovRequestPromise = receiver.payloadReceived(({ url }) => url === '/evp_proxy/v2/api/v2/citestcov')
        const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/evp_proxy/v2/api/v2/citestcycle')

        Promise.all([
          itrConfigRequestPromise,
          codeCovRequestPromise,
          eventsRequestPromise
        ]).then(([itrConfigRequest, codeCovRequest, eventsRequest]) => {
          assert.notProperty(itrConfigRequest.headers, 'dd-api-key')
          assert.notProperty(itrConfigRequest.headers, 'dd-application-key')
          assert.propertyVal(itrConfigRequest.headers, 'x-datadog-evp-subdomain', 'api')

          const [coveragePayload] = codeCovRequest.payload
          assert.notProperty(codeCovRequest.headers, 'dd-api-key')
          assert.propertyVal(codeCovRequest.headers, 'x-datadog-evp-subdomain', 'event-platform-intake')

          assert.propertyVal(coveragePayload, 'name', 'coverage1')
          assert.propertyVal(coveragePayload, 'filename', 'coverage1.msgpack')
          assert.propertyVal(coveragePayload, 'type', 'application/msgpack')
          assert.include(coveragePayload.content, {
            version: 1
          })
          const allCoverageFiles = codeCovRequest.payload
            .flatMap(coverage => coverage.content.files)
            .map(file => file.filename)

          assert.includeMembers(allCoverageFiles, expectedCoverageFiles)
          assert.exists(coveragePayload.content.span_id)
          assert.exists(coveragePayload.content.trace_id)

          const eventTypes = eventsRequest.payload.events.map(event => event.type)
          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_session_end'])
          const numSuites = eventTypes.reduce(
            (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
          )
          assert.equal(numSuites, 2)
          done()
        }).catch(done)

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: getCiVisEvpProxyConfig(receiver.port),
            stdio: 'inherit'
          }
        )
      })
      it('does not report code coverage if disabled by the API', (done) => {
        receiver.setSettings({
          code_coverage: false,
          tests_skipping: false
        })

        receiver.assertPayloadReceived(() => {
          const error = new Error('it should not report code coverage')
          done(error)
        }, ({ url }) => url === '/evp_proxy/v2/api/v2/citestcov')

        receiver.assertPayloadReceived(({ headers, payload }) => {
          assert.notProperty(headers, 'dd-api-key')
          assert.propertyVal(headers, 'x-datadog-evp-subdomain', 'citestcycle-intake')
          const eventTypes = payload.events.map(event => event.type)
          assert.includeMembers(eventTypes, ['test', 'test_session_end', 'test_suite_end'])
        }, ({ url }) => url === '/evp_proxy/v2/api/v2/citestcycle').then(() => done()).catch(done)

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: getCiVisEvpProxyConfig(receiver.port),
            stdio: 'inherit'
          }
        )
      })
      it('can skip suites received by the intelligent test runner API and still reports code coverage', (done) => {
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/test/ci-visibility-test.js'
          }
        }])

        const skippableRequestPromise = receiver.payloadReceived(
          ({ url }) => url === '/evp_proxy/v2/api/v2/ci/tests/skippable'
        )
        const coverageRequestPromise = receiver.payloadReceived(({ url }) => url === '/evp_proxy/v2/api/v2/citestcov')
        const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/evp_proxy/v2/api/v2/citestcycle')

        Promise.all([
          skippableRequestPromise,
          coverageRequestPromise,
          eventsRequestPromise
        ]).then(([skippableRequest, coverageRequest, eventsRequest]) => {
          assert.notProperty(skippableRequest.headers, 'dd-api-key')
          assert.notProperty(skippableRequest.headers, 'dd-application-key')
          assert.propertyVal(skippableRequest.headers, 'x-datadog-evp-subdomain', 'api')

          const [coveragePayload] = coverageRequest.payload
          assert.notProperty(coverageRequest.headers, 'dd-api-key')
          assert.propertyVal(coverageRequest.headers, 'x-datadog-evp-subdomain', 'event-platform-intake')
          assert.propertyVal(coveragePayload, 'name', 'coverage1')
          assert.propertyVal(coveragePayload, 'filename', 'coverage1.msgpack')
          assert.propertyVal(coveragePayload, 'type', 'application/msgpack')

          assert.notProperty(eventsRequest.headers, 'dd-api-key')
          assert.propertyVal(eventsRequest.headers, 'x-datadog-evp-subdomain', 'citestcycle-intake')
          const eventTypes = eventsRequest.payload.events.map(event => event.type)
          const skippedTest = eventsRequest.payload.events.find(event =>
            event.content.resource === 'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests'
          )
          assert.notExists(skippedTest)
          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_session_end'])
          const numSuites = eventTypes.reduce(
            (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
          )
          assert.equal(numSuites, 1)
          done()
        })

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: getCiVisEvpProxyConfig(receiver.port),
            stdio: 'inherit'
          }
        )
      })
      it('does not skip tests if git metadata upload fails', (done) => {
        receiver.assertPayloadReceived(() => {
          const error = new Error('should not request skippable')
          done(error)
        }, ({ url }) => url === '/evp_proxy/v2/api/v2/ci/tests/skippable')

        receiver.assertPayloadReceived(({ headers, payload }) => {
          assert.notProperty(headers, 'dd-api-key')
          assert.propertyVal(headers, 'x-datadog-evp-subdomain', 'citestcycle-intake')
          const eventTypes = payload.events.map(event => event.type)
          // because they are not skipped
          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_session_end'])
          const numSuites = eventTypes.reduce(
            (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
          )
          assert.equal(numSuites, 2)
        }, ({ url }) => url === '/evp_proxy/v2/api/v2/citestcycle').then(() => done()).catch(done)

        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/test/ci-visibility-test.js'
          }
        }])

        receiver.setGitUploadStatus(404)

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: getCiVisEvpProxyConfig(receiver.port),
            stdio: 'inherit'
          }
        )
      })
      it('does not skip tests if test skipping is disabled by the API', (done) => {
        receiver.assertPayloadReceived(() => {
          const error = new Error('should not request skippable')
          done(error)
        }, ({ url }) => url === '/evp_proxy/v2/api/v2/ci/tests/skippable')

        receiver.assertPayloadReceived(({ headers, payload }) => {
          assert.notProperty(headers, 'dd-api-key')
          assert.propertyVal(headers, 'x-datadog-evp-subdomain', 'citestcycle-intake')
          const eventTypes = payload.events.map(event => event.type)
          // because they are not skipped
          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_session_end'])
          const numSuites = eventTypes.reduce(
            (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
          )
          assert.equal(numSuites, 2)
        }, ({ url }) => url === '/evp_proxy/v2/api/v2/citestcycle').then(() => done()).catch(done)

        receiver.setSettings({
          code_coverage: true,
          tests_skipping: false
        })

        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/test/ci-visibility-test.js'
          }
        }])

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: getCiVisEvpProxyConfig(receiver.port),
            stdio: 'inherit'
          }
        )
      })
    })
  })
})
