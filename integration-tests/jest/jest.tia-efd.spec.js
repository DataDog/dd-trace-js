'use strict'

const assert = require('node:assert/strict')

const { once } = require('node:events')
const { fork, exec } = require('child_process')
const path = require('path')
const fs = require('fs')
const { inspect } = require('node:util')
const { assertObjectContains } = require('../helpers')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  TEST_CODE_COVERAGE_ENABLED,
  TEST_ITR_SKIPPING_ENABLED,
  TEST_ITR_TESTS_SKIPPED,
  TEST_CODE_COVERAGE_LINES_PCT,
  TEST_SUITE,
  TEST_STATUS,
  TEST_SKIPPED_BY_ITR,
  TEST_ITR_SKIPPING_TYPE,
  TEST_ITR_SKIPPING_COUNT,
  TEST_ITR_UNSKIPPABLE,
  TEST_ITR_FORCED_RUN,
  TEST_IS_NEW,
  TEST_HAS_DYNAMIC_NAME,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_NAME,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_RETRY_REASON,
  DI_ERROR_DEBUG_INFO_CAPTURED,
  DI_DEBUG_ERROR_PREFIX,
  DI_DEBUG_ERROR_FILE_SUFFIX,
  DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX,
  DI_DEBUG_ERROR_LINE_SUFFIX,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_RETRY_REASON_TYPES,
  TEST_FINAL_STATUS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS,
  getLineCoverageBitmap,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { ERROR_MESSAGE } = require('../../packages/dd-trace/src/constants')
const { DD_MAJOR, NODE_MAJOR } = require('../../version')

const testFile = 'ci-visibility/run-jest.js'
const expectedCoverageFiles = [
  'ci-visibility/test/sum.js',
  'ci-visibility/test/ci-visibility-test.js',
  'ci-visibility/test/ci-visibility-test-2.js',
]
const runTestsCommand = 'node ./ci-visibility/run-jest.js'

const requestedJestVersion = process.env.JEST_VERSION || 'latest'
const oldestJestVersion = DD_MAJOR >= 6 ? '28.0.0' : '24.8.0'
const JEST_VERSION = requestedJestVersion === 'oldest' ? oldestJestVersion : requestedJestVersion
const onlyLatestIt = JEST_VERSION === 'latest' ? it : it.skip
const shouldInstallJestEnvironmentJsdom = JEST_VERSION === 'latest' || Number(JEST_VERSION.split('.')[0]) >= 28
const isJestCoverageBackfillSupported = JEST_VERSION === 'latest' || Number(JEST_VERSION.split('.')[0]) >= 28

function assertItrSkippingEnabledTags (events, expected) {
  const testSuite = events.find(event => event.type === 'test_suite_end').content
  assert.strictEqual(testSuite.meta[TEST_ITR_SKIPPING_ENABLED], expected)
  const test = events.find(event => event.type === 'test').content
  assert.strictEqual(test.meta[TEST_ITR_SKIPPING_ENABLED], expected)
}

function getLinesBitmapBase64 (startLine, endLine) {
  const lineCoverage = {}
  for (let line = startLine; line <= endLine; line++) {
    lineCoverage[line] = 1
  }
  return getLineCoverageBitmap(lineCoverage, true).toString('base64')
}

// TODO: add ESM tests
describe(`jest@${JEST_VERSION} commonJS`, () => {
  let receiver
  let childProcess
  let cwd
  let startupTestFile
  let testOutput = ''

  useSandbox([
    `jest@${JEST_VERSION}`,
    `jest-jasmine2@${JEST_VERSION}`,
    `babel-jest@${JEST_VERSION}`,
    // jest-environment-jsdom is included in older versions of jest
    shouldInstallJestEnvironmentJsdom ? `jest-environment-jsdom@${JEST_VERSION}` : '',
    // jest-circus is not included in older versions of jest
    JEST_VERSION !== 'latest' ? `jest-circus@${JEST_VERSION}` : '',
    '@babel/core',
    '@babel/preset-typescript',
    '@happy-dom/jest-environment',
    'office-addin-mock',
    'winston',
    'jest-image-snapshot',
  ].filter(Boolean), true)

  before(function () {
    cwd = sandboxCwd()
    startupTestFile = path.join(cwd, testFile)
  })

  beforeEach(async function () {
    receiver = await new FakeCiVisIntake().start()
  })

  afterEach(async () => {
    childProcess.kill()
    testOutput = ''
    await receiver.stop()
  })

  context('intelligent test runner', () => {
    context('if the agent is not event platform proxy compatible', () => {
      it('does not do any intelligent test runner request', (done) => {
        receiver.setInfoResponse({ endpoints: [] })

        receiver.assertPayloadReceived(() => {
          const error = new Error('should not request search_commits')
          done(error)
        }, ({ url }) => url === '/evp_proxy/v2/api/v2/git/repository/search_commits').catch(() => {})
        receiver.assertPayloadReceived(() => {
          const error = new Error('should not request search_commits')
          done(error)
        }, ({ url }) => url === '/api/v2/git/repository/search_commits').catch(() => {})
        receiver.assertPayloadReceived(() => {
          const error = new Error('should not request setting')
          done(error)
        }, ({ url }) => url === '/api/v2/libraries/tests/services/setting').catch(() => {})
        receiver.assertPayloadReceived(() => {
          const error = new Error('should not request setting')
          done(error)
        }, ({ url }) => url === '/evp_proxy/v2/api/v2/libraries/tests/services/setting').catch(() => {})

        receiver.assertPayloadReceived(({ payload }) => {
          const testSpans = payload.flatMap(trace => trace)
          const resourceNames = testSpans.map(span => span.resource)

          assertObjectContains(resourceNames,
            [
              'ci-visibility/test/ci-visibility-test-2.js.ci visibility 2 can report tests 2',
              'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests',
            ]
          )
        }, ({ url }) => url === '/v0.4/traces').then(() => done()).catch(done)

        childProcess = fork(startupTestFile, {
          cwd,
          env: getCiVisEvpProxyConfig(receiver.port),
          stdio: 'pipe',
        })
      })
    })

    it('can report code coverage', async () => {
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: true,
        coverage_report_upload_enabled: true,
        tests_skipping: true,
      })

      const libraryConfigRequestPromise = receiver.payloadReceived(
        ({ url }) => url === '/api/v2/libraries/tests/services/setting'
      )
      const codeCovRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcov')
      const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle')

      const requestsPromises = Promise.all([
        libraryConfigRequestPromise,
        codeCovRequestPromise,
        eventsRequestPromise,
      ]).then(([libraryConfigRequest, codeCovRequest, eventsRequest]) => {
        assert.strictEqual(libraryConfigRequest.headers['dd-api-key'], '1')

        assertObjectContains(codeCovRequest, {
          headers: {
            'dd-api-key': '1',
          },
          payload: [{
            name: 'coverage1',
            filename: 'coverage1.msgpack',
            type: 'application/msgpack',
            content: {
              version: 2,
            },
          }],
        })
        const coverages = codeCovRequest.payload.flatMap(coverage => coverage.content.coverages)
        const allCoverageFiles = coverages
          .flatMap(file => file.files)
          .map(file => file.filename)
        const coveredSourceFile = coverages
          .flatMap(coverage => coverage.files)
          .find(file => file.filename === 'ci-visibility/test/sum.js')
        const sessionCoverage = coverages.find(coverage => !coverage.test_suite_id)

        assertObjectContains(allCoverageFiles.sort(), expectedCoverageFiles.sort())
        assert.ok(coveredSourceFile.bitmap, 'covered source files should report line coverage bitmaps')
        if (isJestCoverageBackfillSupported) {
          assert.ok(sessionCoverage, 'session executable line coverage should be reported')
          assert.ok(
            sessionCoverage.files.every(file => file.bitmap),
            'session executable line coverage files should report bitmaps'
          )
        } else {
          assert.strictEqual(sessionCoverage, undefined)
        }

        const [coveragePayload] = codeCovRequest.payload
        assert.ok(coveragePayload.content.coverages[0].test_session_id)
        assert.ok(coveragePayload.content.coverages[0].test_suite_id)

        const testSession = eventsRequest.payload.events.find(event => event.type === 'test_session_end').content
        assert.ok(testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT])

        const eventTypes = eventsRequest.payload.events.map(event => event.type)
        assertObjectContains(eventTypes, ['test', 'test_suite_end', 'test_session_end', 'test_module_end'])
        const numSuites = eventTypes.reduce(
          (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
        )
        assert.strictEqual(numSuites, 2)
      })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            ENABLE_CODE_COVERAGE: '1',
          },
        }
      )
      await Promise.all([
        requestsPromises,
        once(childProcess, 'exit'),
      ])
    })

    it('does not report per test code coverage if disabled by the API', (done) => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
      })

      receiver.assertPayloadReceived(() => {
        const error = new Error('it should not report code coverage')
        done(error)
      }, ({ url }) => url === '/api/v2/citestcov').catch(() => {})

      receiver.assertPayloadReceived(({ headers, payload }) => {
        assert.strictEqual(headers['dd-api-key'], '1')
        const eventTypes = payload.events.map(event => event.type)
        assertObjectContains(eventTypes, ['test', 'test_suite_end', 'test_session_end', 'test_module_end'])
        const testSession = payload.events.find(event => event.type === 'test_session_end').content
        assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'false')
        assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'false')
        assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'false')
        assert.ok(testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT])
        const testModule = payload.events.find(event => event.type === 'test_module_end').content
        assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'false')
        assert.strictEqual(testModule.meta[TEST_CODE_COVERAGE_ENABLED], 'false')
        assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_ENABLED], 'false')
        assertItrSkippingEnabledTags(payload.events, 'false')
      }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            ENABLE_CODE_COVERAGE: '1',
          },
        }
      )
    })

    it('can skip suites received by the intelligent test runner API and still reports code coverage', (done) => {
      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: {
          suite: 'ci-visibility/test/ci-visibility-test.js',
        },
      }])
      receiver.setSkippableCoverage({
        'ci-visibility/test/ci-visibility-test.js': getLinesBitmapBase64(1, 20),
      })

      const skippableRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/ci/tests/skippable')
      const coverageRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcov')
      const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle')

      Promise.all([
        skippableRequestPromise,
        coverageRequestPromise,
        eventsRequestPromise,
      ]).then(([skippableRequest, coverageRequest, eventsRequest]) => {
        assert.strictEqual(skippableRequest.headers['dd-api-key'], '1')
        const [coveragePayload] = coverageRequest.payload
        assert.strictEqual(coverageRequest.headers['dd-api-key'], '1')
        assertObjectContains(coveragePayload, {
          name: 'coverage1',
          filename: 'coverage1.msgpack',
          type: 'application/msgpack',
        })

        assert.strictEqual(eventsRequest.headers['dd-api-key'], '1')
        const eventTypes = eventsRequest.payload.events.map(event => event.type)
        const skippedSuite = eventsRequest.payload.events.find(event =>
          event.content.resource === 'test_suite.ci-visibility/test/ci-visibility-test.js'
        ).content
        assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')
        assert.strictEqual(skippedSuite.meta[TEST_SKIPPED_BY_ITR], 'true')

        assertObjectContains(eventTypes, ['test', 'test_suite_end', 'test_session_end', 'test_module_end'])
        const numSuites = eventTypes.reduce(
          (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
        )
        assert.strictEqual(numSuites, 2)
        const testSession = eventsRequest.payload.events.find(event => event.type === 'test_session_end').content
        assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'true')
        assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
        assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
        assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_TYPE], 'suite')
        assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 1)
        const testModule = eventsRequest.payload.events.find(event => event.type === 'test_module_end').content
        assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'true')
        assert.strictEqual(testModule.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
        assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
        assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_TYPE], 'suite')
        assert.strictEqual(testModule.metrics[TEST_ITR_SKIPPING_COUNT], 1)
        assertItrSkippingEnabledTags(eventsRequest.payload.events, 'true')
        done()
      }).catch(done)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            ENABLE_CODE_COVERAGE: '1',
          },
        }
      )
    })

    it('marks the test session as skipped if every suite is skipped', (done) => {
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: false,
        tests_skipping: true,
      })
      receiver.setSuitesToSkip(
        [
          {
            type: 'suite',
            attributes: {
              suite: 'ci-visibility/test/ci-visibility-test.js',
            },
          },
          {
            type: 'suite',
            attributes: {
              suite: 'ci-visibility/test/ci-visibility-test-2.js',
            },
          },
        ]
      )

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_STATUS], 'skip')
        })
      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('does not skip tests if git metadata upload fails', (done) => {
      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: {
          suite: 'ci-visibility/test/ci-visibility-test.js',
        },
      }])

      receiver.setGitUploadStatus(404)

      receiver.assertPayloadReceived(() => {
        const error = new Error('should not request skippable')
        done(error)
      }, ({ url }) => url === '/api/v2/ci/tests/skippable').catch(() => {})

      receiver.assertPayloadReceived(({ headers, payload }) => {
        assert.strictEqual(headers['dd-api-key'], '1')
        const eventTypes = payload.events.map(event => event.type)
        // because they are not skipped
        assertObjectContains(eventTypes, ['test', 'test_suite_end', 'test_session_end', 'test_module_end'])
        const numSuites = eventTypes.reduce(
          (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
        )
        assert.strictEqual(numSuites, 2)
        const testSession = payload.events.find(event => event.type === 'test_session_end').content
        assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'false')
        assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
        assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
        const testModule = payload.events.find(event => event.type === 'test_module_end').content
        assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'false')
        assert.strictEqual(testModule.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
        assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
        assertItrSkippingEnabledTags(payload.events, 'true')
      }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )
    })

    it('does not skip tests if test skipping is disabled by the API', (done) => {
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: true,
        tests_skipping: false,
      })

      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: {
          suite: 'ci-visibility/test/ci-visibility-test.js',
        },
      }])

      receiver.assertPayloadReceived(() => {
        const error = new Error('should not request skippable')
        done(error)
      }, ({ url }) => url === '/api/v2/ci/tests/skippable').catch(() => {})

      receiver.assertPayloadReceived(({ headers, payload }) => {
        assert.strictEqual(headers['dd-api-key'], '1')
        const eventTypes = payload.events.map(event => event.type)
        // because they are not skipped
        assertObjectContains(eventTypes, ['test', 'test_suite_end', 'test_session_end', 'test_module_end'])
        const numSuites = eventTypes.reduce(
          (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
        )
        assert.strictEqual(numSuites, 2)
      }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )
    })

    it('does not skip suites if suite is marked as unskippable', (done) => {
      const coveredSkippedLines = getLinesBitmapBase64(1, 20)
      receiver.setSuitesToSkip([
        {
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/unskippable-test/test-to-skip.js',
          },
        },
        {
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/unskippable-test/test-unskippable.js',
          },
        },
      ])
      receiver.setSkippableCoverage({
        'ci-visibility/unskippable-test/test-to-skip.js': coveredSkippedLines,
        'ci-visibility/unskippable-test/test-unskippable.js': coveredSkippedLines,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const suites = events.filter(event => event.type === 'test_suite_end')

          assert.strictEqual(suites.length, 3)

          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content
          assert.strictEqual(testSession.meta[TEST_ITR_FORCED_RUN], 'true')
          assert.strictEqual(testSession.meta[TEST_ITR_UNSKIPPABLE], 'true')
          assert.strictEqual(testModule.meta[TEST_ITR_FORCED_RUN], 'true')
          assert.strictEqual(testModule.meta[TEST_ITR_UNSKIPPABLE], 'true')

          const passedSuite = suites.find(
            event => event.content.resource === 'test_suite.ci-visibility/unskippable-test/test-to-run.js'
          )
          const skippedSuite = suites.find(
            event => event.content.resource === 'test_suite.ci-visibility/unskippable-test/test-to-skip.js'
          )
          const forcedToRunSuite = suites.find(
            event => event.content.resource === 'test_suite.ci-visibility/unskippable-test/test-unskippable.js'
          )
          // It does not mark as unskippable if there is no docblock
          assert.strictEqual(passedSuite.content.meta[TEST_STATUS], 'pass')
          assert.ok(!(TEST_ITR_UNSKIPPABLE in passedSuite.content.meta))
          assert.ok(!(TEST_ITR_FORCED_RUN in passedSuite.content.meta))

          assert.strictEqual(skippedSuite.content.meta[TEST_STATUS], 'skip')
          assert.ok(!(TEST_ITR_UNSKIPPABLE in skippedSuite.content.meta))
          assert.ok(!(TEST_ITR_FORCED_RUN in skippedSuite.content.meta))

          assert.strictEqual(forcedToRunSuite.content.meta[TEST_STATUS], 'pass')
          assert.strictEqual(forcedToRunSuite.content.meta[TEST_ITR_UNSKIPPABLE], 'true')
          assert.strictEqual(forcedToRunSuite.content.meta[TEST_ITR_FORCED_RUN], 'true')
        }, 25000)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'unskippable-test/test-',
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('only sets forced to run if suite was going to be skipped by ITR', (done) => {
      const coveredSkippedLines = getLinesBitmapBase64(1, 20)
      receiver.setSuitesToSkip([
        {
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/unskippable-test/test-to-skip.js',
          },
        },
      ])
      receiver.setSkippableCoverage({
        'ci-visibility/unskippable-test/test-to-skip.js': coveredSkippedLines,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const suites = events.filter(event => event.type === 'test_suite_end')

          assert.strictEqual(suites.length, 3)

          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content
          assert.ok(!(TEST_ITR_FORCED_RUN in testSession.meta))
          assert.strictEqual(testSession.meta[TEST_ITR_UNSKIPPABLE], 'true')
          assert.ok(!(TEST_ITR_FORCED_RUN in testModule.meta))
          assert.strictEqual(testModule.meta[TEST_ITR_UNSKIPPABLE], 'true')

          const passedSuite = suites.find(
            event => event.content.resource === 'test_suite.ci-visibility/unskippable-test/test-to-run.js'
          )
          const skippedSuite = suites.find(
            event => event.content.resource === 'test_suite.ci-visibility/unskippable-test/test-to-skip.js'
          ).content
          const nonSkippedSuite = suites.find(
            event => event.content.resource === 'test_suite.ci-visibility/unskippable-test/test-unskippable.js'
          ).content

          // It does not mark as unskippable if there is no docblock
          assert.strictEqual(passedSuite.content.meta[TEST_STATUS], 'pass')
          assert.ok(!(TEST_ITR_UNSKIPPABLE in passedSuite.content.meta))
          assert.ok(!(TEST_ITR_FORCED_RUN in passedSuite.content.meta))

          assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')

          assert.strictEqual(nonSkippedSuite.meta[TEST_STATUS], 'pass')
          assert.strictEqual(nonSkippedSuite.meta[TEST_ITR_UNSKIPPABLE], 'true')
          // it was not forced to run because it wasn't going to be skipped
          assert.ok(!(TEST_ITR_FORCED_RUN in nonSkippedSuite.meta))
        }, 25000)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'unskippable-test/test-',
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('sets _dd.ci.itr.tests_skipped to false if the received suite is not skipped', (done) => {
      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: {
          suite: 'ci-visibility/test/not-existing-test.js',
        },
      }])
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'false')
          assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
          assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
          const testModule = events.find(event => event.type === 'test_module_end').content
          assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'false')
          assert.strictEqual(testModule.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
          assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
          assertItrSkippingEnabledTags(events, 'true')
        }, 25000)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('reports itr_correlation_id in test suites', (done) => {
      const itrCorrelationId = '4321'
      receiver.setItrCorrelationId(itrCorrelationId)
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSuites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
          testSuites.forEach(testSuite => {
            assert.strictEqual(testSuite.itr_correlation_id, itrCorrelationId)
          })
        }, 25000)
      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('works with multi project setup and test skipping', (done) => {
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: true,
        coverage_report_upload_enabled: true,
        tests_skipping: true,
      })

      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: {
          suite: 'ci-visibility/test/ci-visibility-test.js',
        },
      }])
      receiver.setSkippableCoverage({
        'ci-visibility/test/ci-visibility-test.js': getLinesBitmapBase64(1, 20),
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          // suites for both projects in the multi-project config are reported as skipped
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSuites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)

          const skippedSuites = testSuites.filter(
            suite => suite.resource === 'test_suite.ci-visibility/test/ci-visibility-test.js'
          )
          assert.strictEqual(skippedSuites.length, 2)

          skippedSuites.forEach(skippedSuite => {
            assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')
            assert.strictEqual(skippedSuite.meta[TEST_SKIPPED_BY_ITR], 'true')
          })
        })

      childProcess = exec(
        'node ./node_modules/jest/bin/jest --config config-jest-multiproject.js',
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('does not run coverage reporters when TIA forces coverage collection', async () => {
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: true,
        coverage_report_upload_enabled: false,
        tests_skipping: true,
      })

      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: {
          suite: 'ci-visibility/test/ci-visibility-test.js',
        },
      }])

      const lcovPath = path.join(cwd, 'coverage', 'lcov.info')
      fs.rmSync(path.join(cwd, 'coverage'), { recursive: true, force: true })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            COVERAGE_REPORTERS: 'lcov',
          },
        }
      )
      try {
        const [exitCode] = await once(childProcess, 'exit')
        assert.strictEqual(exitCode, 0)
        assert.strictEqual(fs.existsSync(lcovPath), false)
      } finally {
        fs.rmSync(path.join(cwd, 'coverage'), { recursive: true, force: true })
      }
    })

    it('keeps user coverage reporters when code coverage is enabled by the user', async () => {
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: true,
        coverage_report_upload_enabled: true,
        tests_skipping: true,
      })

      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: {
          suite: 'ci-visibility/test/ci-visibility-test.js',
        },
      }])

      const lcovPath = path.join(cwd, 'coverage', 'lcov.info')
      fs.rmSync(path.join(cwd, 'coverage'), { recursive: true, force: true })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            ENABLE_CODE_COVERAGE: '1',
            COVERAGE_REPORTERS: 'lcov',
          },
        }
      )
      try {
        await once(childProcess, 'exit')
        assert.strictEqual(fs.existsSync(lcovPath), true)
      } finally {
        fs.rmSync(path.join(cwd, 'coverage'), { recursive: true, force: true })
      }
    })

    it('calculates total code coverage using skippable suite coverage', async () => {
      const coveredSkippedLines = getLinesBitmapBase64(1, 20)
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: true,
        coverage_report_upload_enabled: true,
        tests_skipping: true,
      })

      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: {
          suite: 'ci-visibility/test-total-code-coverage/test-skipped.js',
        },
      }])
      receiver.setSkippableCoverage({
        'ci-visibility/test-total-code-coverage/test-skipped.js': coveredSkippedLines,
        'ci-visibility/test-total-code-coverage/unused-dependency.js': coveredSkippedLines,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end').content

          assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'true')
          // Jest still adds untested files to total coverage, including unused-dependency.js from the skipped
          // suite. The result stays at 100% because backend meta.coverage backfills those skipped lines before the
          // test session total is published.
          if (isJestCoverageBackfillSupported) {
            assert.strictEqual(testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT], 100)
          } else {
            assert.strictEqual(testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT], undefined)
          }
        })

      childProcess = exec(
        runTestsCommand, // Requirement: the user must've opted in to code coverage
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'ci-visibility/test-total-code-coverage/test-',
            COLLECT_COVERAGE_FROM: '**/test-total-code-coverage/**',
            ENABLE_CODE_COVERAGE: '1',
          },
        }
      )

      const [exitCode] = await once(childProcess, 'exit')
      assert.strictEqual(exitCode, 0)
      await eventsPromise
    })

    it('reports code coverage relative to the repository root, not working directory', (done) => {
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: true,
        tests_skipping: false,
      })

      const codeCoveragesPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcov'), (payloads) => {
          const coveredFiles = payloads
            .flatMap(({ payload }) => payload)
            .flatMap(({ content: { coverages } }) => coverages)
            .flatMap(({ files }) => files)
            .map(({ filename }) => filename)

          assertObjectContains(coveredFiles, [
            'ci-visibility/subproject/dependency.js',
            'ci-visibility/subproject/subproject-test.js',
          ])
        }, 5000)

      childProcess = exec(
        'node ./node_modules/jest/bin/jest --config config-jest.js --rootDir ci-visibility/subproject',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            ENABLE_CODE_COVERAGE: '1',
            PROJECTS: JSON.stringify([{
              testMatch: ['**/subproject-test*'],
              testEnvironment: 'node',
              testRunner: 'jest-circus/runner',
            }]),
          },
        }
      )

      childProcess.on('exit', () => {
        codeCoveragesPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('skips repository-relative suites when jest rootDir is a subproject', async () => {
      const suite = 'ci-visibility/subproject/subproject-test.js'
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: true,
        coverage_report_upload_enabled: true,
        tests_skipping: true,
      })
      receiver.setSuitesToSkip([
        {
          type: 'suite',
          attributes: {
            suite,
          },
        },
      ])
      receiver.setSkippableCoverage({
        [suite]: getLinesBitmapBase64(1, 11),
        'ci-visibility/subproject/dependency.js': getLinesBitmapBase64(1, 5),
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const skippedSuites = events
            .filter(event => event.type === 'test_suite_end')
            .filter(event => event.content.meta[TEST_SKIPPED_BY_ITR] === 'true')
          const skippedSuite = events.find(event => {
            return event.type === 'test_suite_end' && event.content.resource === `test_suite.${suite}`
          }).content
          const testSession = events.find(event => event.type === 'test_session_end').content

          assert.strictEqual(skippedSuites.length, 1)
          assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')
          assert.strictEqual(skippedSuite.meta[TEST_SKIPPED_BY_ITR], 'true')
          assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'true')
          if (isJestCoverageBackfillSupported) {
            assert.strictEqual(testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT], 100)
          } else {
            assert.strictEqual(testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT], undefined)
          }
        })

      childProcess = exec(
        'node ./node_modules/jest/bin/jest --config config-jest.js --rootDir ci-visibility/subproject --coverage',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            COLLECT_COVERAGE_FROM: 'subproject-test.js,subproject-test-2.js,dependency.js',
            PROJECTS: JSON.stringify([{
              testMatch: ['**/subproject-test*'],
              testEnvironment: 'node',
              testRunner: 'jest-circus/runner',
            }]),
          },
        }
      )

      const [, [exitCode]] = await Promise.all([
        eventsPromise,
        once(childProcess, 'exit'),
      ])
      assert.strictEqual(exitCode, 0)
    })

    it('report code coverage with all mocked files', async () => {
      const codeCovRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcov')

      const assertCodeCoverage = codeCovRequestPromise.then((codeCovRequest) => {
        const allCoverageFiles = codeCovRequest.payload
          .flatMap(coverage => coverage.content.coverages)
          .flatMap(file => file.files)
          .map(file => file.filename)

        assertObjectContains(allCoverageFiles, [
          'ci-visibility/test/sum.js',
          'ci-visibility/test/static-mock.js',
          'ci-visibility/jest/mocked-test.js',
        ])
      })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            ENABLE_CODE_COVERAGE: '1',
            TESTS_TO_RUN: 'jest/mocked-test.js',
          },
        }
      )
      await Promise.all([
        once(childProcess, 'exit'),
        assertCodeCoverage,
      ])
    })
  })

  context('error tags', () => {
    it(
      'tags session and children with _dd.ci.library_configuration_error.settings when settings fails 4xx',
      async () => {
        receiver.setSettingsResponseCode(404)
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS], 'true')
            const testModule = events.find(event => event.type === 'test_module_end')
            assert.ok(testModule, 'should have test module event')
            assert.strictEqual(testModule.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS], 'true')
            const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
            assert.ok(testSuiteEvent, 'should have test suite event')
            assert.strictEqual(testSuiteEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS], 'true')
            const testEvent = events.find(event => event.type === 'test')
            assert.ok(testEvent, 'should have test event')
            assert.strictEqual(testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS], 'true')
          })
        childProcess = exec(runTestsCommand, {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        })
        await Promise.all([eventsPromise, once(childProcess, 'exit')])
      })

    it(
      'tags session and children with _dd.ci.library_configuration_error.skippable_tests when request fails 4xx',
      async () => {
        receiver.setSkippableSuitesResponseCode(404)
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS], 'true')
            const testModule = events.find(event => event.type === 'test_module_end')
            assert.ok(testModule, 'should have test module event')
            assert.strictEqual(testModule.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS], 'true')
            const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
            assert.ok(testSuiteEvent, 'should have test suite event')
            assert.strictEqual(testSuiteEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS], 'true')
            const testEvent = events.find(event => event.type === 'test')
            assert.ok(testEvent, 'should have test event')
            assert.strictEqual(testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS], 'true')
          })
        childProcess = exec(runTestsCommand, {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        })
        await Promise.all([eventsPromise, once(childProcess, 'exit')])
      })

    it(
      'tags session and children with _dd.ci.library_configuration_error.known_tests when request fails 4xx',
      async () => {
        receiver.setSettings({ known_tests_enabled: true })
        receiver.setKnownTestsResponseCode(404)
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS], 'true')
            const testModule = events.find(event => event.type === 'test_module_end')
            assert.ok(testModule, 'should have test module event')
            assert.strictEqual(testModule.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS], 'true')
            const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
            assert.ok(testSuiteEvent, 'should have test suite event')
            assert.strictEqual(testSuiteEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS], 'true')
            const testEvent = events.find(event => event.type === 'test')
            assert.ok(testEvent, 'should have test event')
            assert.strictEqual(testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS], 'true')
          })
        childProcess = exec(runTestsCommand, {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        })
        await Promise.all([eventsPromise, once(childProcess, 'exit')])
      })

    it(
      'tags session and children with _dd.ci.library_configuration_error.test_management_tests when request fails',
      async () => {
        receiver.setSettings({ test_management: { enabled: true } })
        receiver.setTestManagementTestsResponseCode(404)
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS], 'true')
            const testModule = events.find(event => event.type === 'test_module_end')
            assert.ok(testModule, 'should have test module event')
            assert.strictEqual(
              testModule.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS], 'true'
            )
            const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
            assert.ok(testSuiteEvent, 'should have test suite event')
            assert.strictEqual(
              testSuiteEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS], 'true'
            )
            const testEvent = events.find(event => event.type === 'test')
            assert.ok(testEvent, 'should have test event')
            assert.strictEqual(testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS], 'true')
          })
        childProcess = exec(runTestsCommand, {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        })
        await Promise.all([eventsPromise, once(childProcess, 'exit')])
      })

    context('when jest is using workers to run tests in parallel', () => {
      it(
        'tags session and children with _dd.ci.library_configuration_error.settings when settings fails 4xx',
        async () => {
          receiver.setSettingsResponseCode(404)
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS], 'true')
              const testModule = events.find(event => event.type === 'test_module_end')
              assert.ok(testModule, 'should have test module event')
              assert.strictEqual(testModule.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS], 'true')
              const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
              assert.ok(testSuiteEvent, 'should have test suite event')
              assert.strictEqual(testSuiteEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS], 'true')
              const testEvent = events.find(event => event.type === 'test')
              assert.ok(testEvent, 'should have test event')
              assert.strictEqual(testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS], 'true')
            })
          childProcess = exec(runTestsCommand, {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              RUN_IN_PARALLEL: 'true',
            },
          })
          await Promise.all([eventsPromise, once(childProcess, 'exit')])
        })

      it(
        'tags session and children with _dd.ci.library_configuration_error.skippable_tests when request fails 4xx',
        async () => {
          receiver.setSkippableSuitesResponseCode(404)
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS], 'true')
              const testModule = events.find(event => event.type === 'test_module_end')
              assert.ok(testModule, 'should have test module event')
              assert.strictEqual(testModule.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS], 'true')
              const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
              assert.ok(testSuiteEvent, 'should have test suite event')
              assert.strictEqual(
                testSuiteEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS], 'true'
              )
              const testEvent = events.find(event => event.type === 'test')
              assert.ok(testEvent, 'should have test event')
              assert.strictEqual(testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS], 'true')
            })
          childProcess = exec(runTestsCommand, {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              RUN_IN_PARALLEL: 'true',
            },
          })
          await Promise.all([eventsPromise, once(childProcess, 'exit')])
        })

      it(
        'tags session and children with _dd.ci.library_configuration_error.known_tests when request fails 4xx',
        async () => {
          receiver.setSettings({ known_tests_enabled: true })
          receiver.setKnownTestsResponseCode(404)
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS], 'true')
              const testModule = events.find(event => event.type === 'test_module_end')
              assert.ok(testModule, 'should have test module event')
              assert.strictEqual(testModule.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS], 'true')
              const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
              assert.ok(testSuiteEvent, 'should have test suite event')
              assert.strictEqual(testSuiteEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS], 'true')
              const testEvent = events.find(event => event.type === 'test')
              assert.ok(testEvent, 'should have test event')
              assert.strictEqual(testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS], 'true')
            })
          childProcess = exec(runTestsCommand, {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              RUN_IN_PARALLEL: 'true',
            },
          })
          await Promise.all([eventsPromise, once(childProcess, 'exit')])
        })

      it(
        'tags session and children with _dd.ci.library_configuration_error.test_management_tests when request fails',
        async () => {
          receiver.setSettings({ test_management: { enabled: true } })
          receiver.setTestManagementTestsResponseCode(404)
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS], 'true')
              const testModule = events.find(event => event.type === 'test_module_end')
              assert.ok(testModule, 'should have test module event')
              assert.strictEqual(
                testModule.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS], 'true'
              )
              const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
              assert.ok(testSuiteEvent, 'should have test suite event')
              assert.strictEqual(
                testSuiteEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS], 'true'
              )
              const testEvent = events.find(event => event.type === 'test')
              assert.ok(testEvent, 'should have test event')
              assert.strictEqual(
                testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS], 'true'
              )
            })
          childProcess = exec(runTestsCommand, {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              RUN_IN_PARALLEL: 'true',
            },
          })
          await Promise.all([eventsPromise, once(childProcess, 'exit')])
        })
    })
  })

  it('sets final_status tag to test status on regular tests without retry features', async () => {
    receiver.setSettings({
      itr_enabled: false,
      code_coverage: false,
      tests_skipping: false,
      flaky_test_retries_enabled: false,
      early_flake_detection: {
        enabled: false,
      },
    })

    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)

        tests.forEach(test => {
          const testName = test.meta[TEST_NAME]
          const testStatus = test.meta[TEST_STATUS]
          const finalStatus = test.meta[TEST_FINAL_STATUS]

          assert.ok(
            finalStatus,
            `Expected TEST_FINAL_STATUS to be set for test "${testName}" with status "${testStatus}"`
          )
          assert.strictEqual(
            finalStatus,
            testStatus,
            `Expected TEST_FINAL_STATUS "${finalStatus}" to match TEST_STATUS "${testStatus}" for test "${testName}"`
          )
        })
      })

    childProcess = exec(
      runTestsCommand,
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: 'test/ci-visibility-test',
        },
        stdio: 'inherit',
      }
    )

    await Promise.all([
      once(childProcess, 'exit'),
      eventsPromise,
    ])
  })

  context('early flake detection', () => {
    it('takes precedence over flaky test retries for new tests', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // All tests are considered new
      receiver.setKnownTests({ jest: {} })
      const NUM_RETRIES_EFD = 2
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
        flaky_test_retries_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.strictEqual(tests.length, 3)
          const efdRetries = tests.filter(t => t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd)
          const atrRetries = tests.filter(t => t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)
          assert.strictEqual(efdRetries.length, NUM_RETRIES_EFD)
          assert.strictEqual(atrRetries.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: { ...getCiVisAgentlessConfig(receiver.port), TESTS_TO_RUN: 'jest-flaky/flaky-fails.js' },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })

    it('preserves test errors when ATR retry suppression is active due to EFD', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // All tests are considered new, so EFD will be active
      receiver.setKnownTests({ jest: {} })
      const NUM_RETRIES_EFD = 2
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
        flaky_test_retries_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const failingTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')

          // Verify that all failing tests have error messages preserved
          // even though ATR retry suppression is active (due to EFD)
          failingTests.forEach(test => {
            assert.ok(
              ERROR_MESSAGE in test.meta,
              'Test error message should be preserved when ATR retry suppression is active'
            )
            assert.ok(test.meta[ERROR_MESSAGE].length > 0, 'Test error message should not be empty')
            // The error should contain information about the assertion failure
            assert.match(test.meta[ERROR_MESSAGE], /deepStrictEqual|Expected|actual/i)
          })

          // Verify EFD is active (ATR should be suppressed)
          const efdRetries = tests.filter(t => t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd)
          const atrRetries = tests.filter(t => t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)
          assert.strictEqual(efdRetries.length, NUM_RETRIES_EFD)
          assert.strictEqual(atrRetries.length, 0)
        }, 30_000)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: { ...getCiVisAgentlessConfig(receiver.port), TESTS_TO_RUN: 'jest-flaky/flaky-fails.js' },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })

    it(
      'sets final_status tag only on last ATR retry when EFD is enabled but not active and ATR is active',
      async () => {
        receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })

        // All tests are known, so EFD will not be active
        receiver.setKnownTests({
          jest: {
            'ci-visibility/jest-flaky/flaky-passes.js': [
              'test-flaky-test-retries can retry flaky tests',
              'test-flaky-test-retries will not retry passed tests',
            ],
          },
        })

        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': 2,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
          flaky_test_retries_enabled: true,
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events
              .filter(event => event.type === 'test')
              .map(event => event.content)
              .filter(test => test.meta[TEST_NAME] === 'test-flaky-test-retries can retry flaky tests')

            // We expect 2 executions: the failed (retry) and the passed (last one)
            assert.strictEqual(tests.length, 3)

            // Only the last execution (the one with status 'pass') should have TEST_FINAL_STATUS tag
            tests.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)).forEach((test, idx) => {
              if (idx < tests.length - 1) {
                assert.ok(!(TEST_FINAL_STATUS in test.meta),
                  'TEST_FINAL_STATUS should not be set on previous runs'
                )
              } else {
                assert.strictEqual(test.meta[TEST_FINAL_STATUS], test.meta[TEST_STATUS])
                assert.strictEqual(test.meta[TEST_STATUS], 'pass')
              }
            })
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN: 'jest-flaky/flaky-passes.js',
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '5',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

    it('sets final_status tag to test status reported to test framework on last retry', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      const knownTestFile = 'ci-visibility/test/ci-visibility-test.js'
      receiver.setKnownTests({
        jest: {
          [knownTestFile]: ['ci visibility can report tests'],
        },
      })
      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          // no other tests are considered new
          const knownTests = tests.filter(test =>
            test.meta[TEST_SUITE] === knownTestFile
          )
          knownTests.forEach(test => {
            // all tests executions are the final executions
            assert.strictEqual(test.meta[TEST_FINAL_STATUS], test.meta[TEST_STATUS])
          })

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
          )
          newTests.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)).forEach((test, index) => {
            if (index < newTests.length - 1) {
              assert.ok(!(TEST_FINAL_STATUS in test.meta))
            } else {
              // only the last execution should have the final status
              assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'pass')
            }
          })
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'test/ci-visibility-test',
            DD_TRACE_DEBUG: '1',
          },
          stdio: 'inherit',
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })
    it('retries new tests', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
        },
      })
      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          // no other tests are considered new
          const oldTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test.js'
          )
          oldTests.forEach(test => {
            assert.ok(!(TEST_IS_NEW in test.meta))
          })
          assert.strictEqual(oldTests.length, 1)

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
          )
          newTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
          })
          const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // all but one has been retried
          assert.strictEqual(newTests.length - 1, retriedTests.length)
          assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
          retriedTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
          })
          // Test name does not change
          newTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_NAME], 'ci visibility 2 can report tests 2')
          })
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: { ...getCiVisEvpProxyConfig(receiver.port), TESTS_TO_RUN: 'test/ci-visibility-test' },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('sets TEST_HAS_FAILED_ALL_RETRIES when all EFD attempts fail', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // fail-test.js will be considered new and will always fail
      receiver.setKnownTests({
        jest: {},
      })
      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const failTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/fail-test.js'
          )

          // Should have 1 initial attempt + NUM_RETRIES_EFD retries
          assert.strictEqual(failTests.length, NUM_RETRIES_EFD + 1)

          // All attempts should be marked as new
          failTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
          })

          // Check retries
          const retriedTests = failTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
          retriedTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
          })

          // Only the last retry should have TEST_HAS_FAILED_ALL_RETRIES set
          const lastRetry = failTests[failTests.length - 1]
          assert.strictEqual(lastRetry.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')

          // Earlier attempts should not have the flag
          for (let i = 0; i < failTests.length - 1; i++) {
            assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in failTests[i].meta))
          }
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: { ...getCiVisEvpProxyConfig(receiver.port), TESTS_TO_RUN: 'test/fail-test' },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('resets mock state between early flake detection retries', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Test is considered new (not in known tests)
      receiver.setKnownTests({ jest: {} })
      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      let stdout = ''
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          // Should have 1 original + NUM_RETRIES_EFD retry attempts
          const mockTests = tests.filter(
            test => test.meta[TEST_NAME] === 'early flake detection tests with mock resets mock state between retries'
          )
          assert.strictEqual(mockTests.length, NUM_RETRIES_EFD + 1)

          // All tests should pass because mock state is reset between retries
          for (const test of mockTests) {
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
          }

          // All should be marked as new
          for (const test of mockTests) {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
          }
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'test-early-flake-detection/test-efd-with-mock',
          },
        }
      )

      childProcess.stdout?.on('data', (chunk) => {
        stdout += chunk.toString()
      })

      childProcess.stderr?.on('data', (chunk) => {
        stdout += chunk.toString()
      })

      const [exitCode] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])

      // Verify the test actually ran
      assert.match(stdout, /I am running EFD with mock/)

      // All retries should pass, so exit code should be 0
      assert.strictEqual(exitCode[0], 0)
    })

    it('handles parameterized tests as a single unit', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test-early-flake-detection/test-parameterized.js will be considered new
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test-early-flake-detection/test.js': ['ci visibility can report tests'],
        },
      })
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 3,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const parameterizedTestFile = 'test-parameterized.js'

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === `ci-visibility/test-early-flake-detection/${parameterizedTestFile}`
          )
          newTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
          })
          // Each parameter is repeated independently
          const testsForFirstParameter = tests.filter(test => test.resource ===
            `ci-visibility/test-early-flake-detection/${parameterizedTestFile}.parameterized test parameter 1`
          )

          const testsForSecondParameter = tests.filter(test => test.resource ===
            `ci-visibility/test-early-flake-detection/${parameterizedTestFile}.parameterized test parameter 2`
          )

          assert.strictEqual(testsForFirstParameter.length, testsForSecondParameter.length)

          // all but one have been retried
          assert.strictEqual(
            testsForFirstParameter.length - 1,
            testsForFirstParameter.filter(test => test.meta[TEST_IS_RETRY] === 'true').length
          )

          assert.strictEqual(
            testsForSecondParameter.length - 1,
            testsForSecondParameter.filter(test => test.meta[TEST_IS_RETRY] === 'true').length
          )
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: { ...getCiVisEvpProxyConfig(receiver.port), TESTS_TO_RUN: 'test-early-flake-detection/test' },
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('is disabled if DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED is false', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
        },
      })
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 3,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const newTests = tests.filter(test =>
            test.meta[TEST_IS_NEW] === 'true'
          )
          // new tests are detected but not retried
          assert.strictEqual(newTests.length, 1)
          const retriedTests = tests.filter(test =>
            test.meta[TEST_IS_RETRY] === 'true'
          )
          assert.strictEqual(retriedTests.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'test/ci-visibility-test',
            DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: 'false',
          },
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('retries flaky tests', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/occasionally-failing-test will be considered new
      receiver.setKnownTests({ jest: {} })

      const NUM_RETRIES_EFD = 5
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // all but one has been retried
          assert.strictEqual(tests.length - 1, retriedTests.length)
          assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
          // Out of NUM_RETRIES_EFD + 1 total runs, half will be passing and half will be failing,
          // based on the global counter in the test file
          const passingTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
          const failingTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.strictEqual(passingTests.length, (NUM_RETRIES_EFD + 1) / 2)
          assert.strictEqual(failingTests.length, (NUM_RETRIES_EFD + 1) / 2)
          // Test name does not change
          retriedTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_NAME], 'fail occasionally fails')
          })
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'test-early-flake-detection/occasionally-failing-test',
          },
        }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
      assert.strictEqual(exitCode, 0)
    })

    it('does not retry new tests that are skipped', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/skipped-and-todo-test will be considered new
      receiver.setKnownTests({ jest: {} })

      const NUM_RETRIES_EFD = 5
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const newSkippedTests = tests.filter(
            test => test.meta[TEST_NAME] === 'ci visibility skip will not be retried'
          )
          assert.strictEqual(newSkippedTests.length, 1)
          assert.strictEqual(newSkippedTests[0].meta[TEST_FINAL_STATUS], 'skip')
          assert.ok(!(TEST_IS_RETRY in newSkippedTests[0].meta))

          const newTodoTests = tests.filter(
            test => test.meta[TEST_NAME] === 'ci visibility todo will not be retried'
          )
          assert.strictEqual(newTodoTests.length, 1)
          assert.ok(!(TEST_IS_RETRY in newTodoTests[0].meta))
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'test-early-flake-detection/skipped-and-todo-test',
          },
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('handles spaces in test names', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })

      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 3,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })
      // Tests from ci-visibility/test/skipped-and-todo-test will be considered new
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test-early-flake-detection/weird-test-names.js': [
            'no describe can do stuff',
            'describe  trailing space ',
          ],
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.strictEqual(tests.length, 2)

          const resourceNames = tests.map(test => test.resource)

          assertObjectContains(resourceNames,
            [
              'ci-visibility/test-early-flake-detection/weird-test-names.js.no describe can do stuff',
              'ci-visibility/test-early-flake-detection/weird-test-names.js.describe  trailing space ',
            ]
          )

          const newTests = tests.filter(
            test => test.meta[TEST_IS_NEW] === 'true'
          )
          // no new tests
          assert.strictEqual(newTests.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'test-early-flake-detection/weird-test-names',
          },
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('does not run EFD if the known tests request fails', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      receiver.setKnownTestsResponseCode(500)

      const NUM_RETRIES_EFD = 5
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      // Request module waits before retrying — need longer gather timeout
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSessionEnd = events.find(event => event.type === 'test_session_end')
          assert.ok(testSessionEnd, 'expected test_session_end event in payloads')
          const testSession = testSessionEnd.content
          assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.strictEqual(tests.length, 2)
          const newTests = tests.filter(
            test => test.meta[TEST_IS_NEW] === 'true'
          )
          assert.strictEqual(newTests.length, 0)
        }, 60000)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'test/ci-visibility-test',
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => done()).catch(done)
      })
    })

    it('retries flaky tests and sets exit code to 0 as long as one attempt passes', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/occasionally-failing-test will be considered new
      receiver.setKnownTests({ jest: {} })

      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
          // Session is passed because at least one retry of the new flaky test passes
          assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // all but one has been retried
          assert.strictEqual(tests.length - 1, retriedTests.length)
          assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
          // Out of NUM_RETRIES_EFD + 1 total runs, half will be passing and half will be failing,
          // based on the global counter in the test file
          const passingTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
          const failingTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.strictEqual(passingTests.length, (NUM_RETRIES_EFD + 1) / 2)
          assert.strictEqual(failingTests.length, (NUM_RETRIES_EFD + 1) / 2)
          // Test name does not change
          retriedTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_NAME], 'fail occasionally fails')
          })
        })

      let testOutput = ''
      childProcess = exec(
        'node ./node_modules/jest/bin/jest --config config-jest.js',
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: '**/ci-visibility/test-early-flake-detection/occasionally-failing-test*',
            SHOULD_CHECK_RESULTS: '1',
          },
        }
      )

      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })

      const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])

      assert.match(testOutput, /2 failed, 2 passed/)
      // Exit code is 0 because at least one retry of the new flaky test passes
      assert.strictEqual(exitCode, 0)

      // Verify Datadog Test Optimization message is shown when exit code is flipped
      assert.match(testOutput, /Datadog Test Optimization/)
      assert.match(testOutput, /\d+ test failure\(s\) were ignored\. Exit code set to 0\./)
      assert.match(testOutput, /Early Flake Detection/)
      assert.match(testOutput, /occasionally-failing-test.*›.*fail occasionally fails/)
    })

    // resetting snapshot state logic only works in latest versions
    onlyLatestIt('works with snapshot tests', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })

      receiver.setKnownTests({
        jest: {
          'ci-visibility/test-early-flake-detection/jest-snapshot.js': [
            'test is not new',
            'test has snapshot and is known',
          ],
        },
      })

      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
          // Session is passed because at least one retry of each new flaky test passes
          assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          // 6 tests, 4 of which are new: 4*(1 test + 3 retries) + 2*(1 test) = 18
          assert.strictEqual(tests.length, 18)

          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // 4*(3 retries)
          assert.strictEqual(retriedTests.length, 12)

          const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
          // 4*(1 test + 3 retries)
          assert.strictEqual(newTests.length, 16)

          const flakyTests = tests.filter(test => test.meta[TEST_NAME] === 'test is flaky')
          assert.strictEqual(flakyTests.length, 4)
          const failedFlakyTests = flakyTests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.strictEqual(failedFlakyTests.length, 2)
          const passedFlakyTests = flakyTests.filter(test => test.meta[TEST_STATUS] === 'pass')
          assert.strictEqual(passedFlakyTests.length, 2)
        })

      childProcess = exec(runTestsCommand, {
        cwd,
        env: {
          ...getCiVisEvpProxyConfig(receiver.port),
          TESTS_TO_RUN: 'ci-visibility/test-early-flake-detection/jest-snapshot',
          CI: '1', // needs to be run as CI so snapshots are not written
          SHOULD_CHECK_RESULTS: '1',
        },
      })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
      // Exit code is 0 because at least one retry of each new flaky test passes
      assert.strictEqual(exitCode, 0)
    })

    // resetting snapshot state logic only works in latest versions
    onlyLatestIt('works with jest-image-snapshot', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })

      receiver.setKnownTests({
        jest: {},
      })

      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
          // Session is passed because at least one retry of the new flaky test passes
          assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          // 1 new test
          assert.strictEqual(tests.length, 4)

          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(retriedTests.length, 3)

          const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
          assert.strictEqual(newTests.length, 4)

          const failedFlakyTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.strictEqual(failedFlakyTests.length, 2)
          const passedFlakyTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
          assert.strictEqual(passedFlakyTests.length, 2)
        })

      childProcess = exec(runTestsCommand, {
        cwd,
        env: {
          ...getCiVisEvpProxyConfig(receiver.port),
          TESTS_TO_RUN: 'ci-visibility/test-early-flake-detection/jest-image-snapshot',
          CI: '1',
          SHOULD_CHECK_RESULTS: '1',
        },
      })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
      // Exit code is 0 because at least one retry of the new flaky test passes
      assert.strictEqual(exitCode, 0)
    })

    it('bails out of EFD if the percentage of new tests is too high', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/ci-visibility-test* will be considered new
      receiver.setKnownTests({ jest: {} })

      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 1,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'faulty')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.strictEqual(tests.length, 2)

          const newTests = tests.filter(
            test => test.meta[TEST_IS_NEW] === 'true'
          )
          // no new tests
          assert.strictEqual(newTests.length, 0)
        })

      childProcess = exec(runTestsCommand, {
        cwd,
        env: {
          ...getCiVisEvpProxyConfig(receiver.port),
          TESTS_TO_RUN: 'test/ci-visibility-test',
        },
      })

      childProcess.on('exit', () => {
        eventsPromise.then(() => done()).catch(done)
      })
    })

    it('works with jsdom', (done) => {
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
        },
      })
      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          // no other tests are considered new
          const oldTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test.js'
          )
          oldTests.forEach(test => {
            assert.ok(!(TEST_IS_NEW in test.meta))
          })
          assert.strictEqual(oldTests.length, 1)

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
          )
          newTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
          })
          const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // all but one has been retried
          assert.strictEqual(newTests.length - 1, retriedTests.length)
          assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
          // Test name does not change
          newTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_NAME], 'ci visibility 2 can report tests 2')
          })
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port), // use agentless for this test, just for variety
            TESTS_TO_RUN: 'test/ci-visibility-test',
            ENABLE_JSDOM: 'true',
            DD_TRACE_DEBUG: '1',
            DD_TRACE_LOG_LEVEL: 'warn',
          },
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })
    // happy-dom>=19 can only be used with CJS from node 20 and above
    const happyDomTest = NODE_MAJOR < 20 ? it.skip : onlyLatestIt
    happyDomTest('works with happy-dom', async () => {
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
        },
      })
      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          // no other tests are considered new
          const oldTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test.js'
          )
          oldTests.forEach(test => {
            assert.ok(!(TEST_IS_NEW in test.meta))
          })
          assert.strictEqual(oldTests.length, 1)

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
          )
          newTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
          })
          const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // all but one has been retried
          assert.strictEqual(newTests.length - 1, retriedTests.length)
          assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
          // Test name does not change
          newTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_NAME], 'ci visibility 2 can report tests 2')
          })
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port), // use agentless for this test, just for variety
            TESTS_TO_RUN: 'test/ci-visibility-test',
            ENABLE_HAPPY_DOM: 'true',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })

    it('disables early flake detection if known tests should not be requested', (done) => {
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 3,
          },
        },
        known_tests_enabled: false,
      })

      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const oldTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test.js'
          )
          oldTests.forEach(test => {
            assert.ok(!(TEST_IS_NEW in test.meta))
          })
          assert.strictEqual(oldTests.length, 1)
          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
          )
          newTests.forEach(test => {
            assert.ok(!(TEST_IS_NEW in test.meta))
          })
          const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(retriedTests.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: { ...getCiVisEvpProxyConfig(receiver.port), TESTS_TO_RUN: 'test/ci-visibility-test' },
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    // it.failing was added in jest@29
    onlyLatestIt('does not retry when it.failing is used', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })
      // FakeCiVisIntake was refactored from shared module-level variables to
      // per-instance #private fields so that concurrent Playwright tests don't
      // interfere with each other. Each new receiver starts with DEFAULT_KNOWN_TESTS
      // (an array), which triggers paginated mode and returns malformed data,
      // causing the known-tests request to fail and EFD to be disabled.
      // Setting an explicit map fixes this. The map must include a `jest` key:
      // jest.js treats a missing `jest` key as "all suites are new" which exceeds
      // the faulty threshold, disabling EFD. An empty `jest: {}` passes that check
      // without causing faulty detection (only 1 suite, threshold is 100).
      // it.failing tests are excluded from EFD new-test analysis in jest.js
      // (`if (event.failing) { return }` in the add_test handler), so they won't
      // be retried or flagged as new regardless of known-tests contents.
      receiver.setKnownTests({ jest: {} })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/jest/failing-test.js'
          )
          newTests.forEach(test => {
            assert.ok(!(TEST_IS_NEW in test.meta))
          })
          assert.strictEqual(newTests.length, 2)

          const passingTests = tests.filter(test =>
            test.meta[TEST_NAME] === 'failing can report failed tests'
          )
          const failingTests = tests.filter(test =>
            test.meta[TEST_NAME] === 'failing can report failing tests as failures'
          )
          passingTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
          })
          failingTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
          })

          const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(retriedTests.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: { ...getCiVisEvpProxyConfig(receiver.port), TESTS_TO_RUN: 'jest/failing-test' },
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    context('parallel mode', () => {
      it('retries new tests', async () => {
        receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
        // Tests from ci-visibility/test/ci-visibility-test-4.js will be considered new
        receiver.setKnownTests({
          jest: {
            'ci-visibility/test/efd-parallel/ci-visibility-test.js': ['ci visibility can report tests'],
            'ci-visibility/test/efd-parallel/ci-visibility-test-2.js': ['ci visibility 2 can report tests 2'],
            'ci-visibility/test/efd-parallel/ci-visibility-test-3.js': ['ci visibility 3 can report tests 3'],
          },
        })

        const NUM_RETRIES_EFD = 3
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            // no other tests are considered new
            const oldTests = tests.filter(test =>
              test.meta[TEST_SUITE] !== 'ci-visibility/test/efd-parallel/ci-visibility-test-4.js'
            )
            oldTests.forEach(test => {
              assert.ok(!(TEST_IS_NEW in test.meta))
            })

            assert.strictEqual(oldTests.length, 3)

            const newTests = tests.filter(test =>
              test.meta[TEST_SUITE] === 'ci-visibility/test/efd-parallel/ci-visibility-test-4.js'
            )
            newTests.forEach(test => {
              assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
            })
            const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            // all but one has been retried
            assert.strictEqual(newTests.length - 1, retriedTests.length)
            assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
            retriedTests.forEach(test => {
              assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
            })
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisEvpProxyConfig(receiver.port),
              TESTS_TO_RUN: 'test/efd-parallel/ci-visibility-test',
              RUN_IN_PARALLEL: 'true',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      it('does not detect new tests if known tests are faulty', async () => {
        receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
        receiver.setKnownTests({
          // invalid known tests
          'no-jest': {},
        })

        const NUM_RETRIES_EFD = 3
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
            assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'faulty')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.strictEqual(tests.length, 4)
            const newTests = tests.filter(
              test => test.meta[TEST_IS_NEW] === 'true'
            )
            assert.strictEqual(newTests.length, 0)
          })

        childProcess = exec(
          runTestsCommand,
          {
            cwd,
            env: {
              ...getCiVisEvpProxyConfig(receiver.port),
              TESTS_TO_RUN: 'test/efd-parallel/ci-visibility-test',
              RUN_IN_PARALLEL: 'true',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      onlyLatestIt('works with snapshot tests', async () => {
        receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })

        receiver.setKnownTests({
          jest: {
            'ci-visibility/test-early-flake-detection/jest-parallel-snapshot-1.js': [
              'parallel snapshot is not new',
              'parallel snapshot has snapshot and is known',
            ],
            'ci-visibility/test-early-flake-detection/jest-parallel-snapshot-2.js': [
              'parallel snapshot 2 is not new',
              'parallel snapshot 2 has snapshot and is known',
            ],
          },
        })

        const NUM_RETRIES_EFD = 3
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

            // 12 tests (6 per file): 8 new, 4 known
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            // 8*(1 test + 3 retries) + 4*(1 test) = 36
            assert.strictEqual(tests.length, 36)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            // 8*(3 retries)
            assert.strictEqual(retriedTests.length, 24)

            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            // 8*(1 test + 3 retries)
            assert.strictEqual(newTests.length, 32)

            const flakyTests = tests.filter(test => test.meta[TEST_NAME].includes('is flaky'))
            assert.strictEqual(flakyTests.length, 8)
            const failedFlakyTests = flakyTests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedFlakyTests.length, 4)
            const passedFlakyTests = flakyTests.filter(test => test.meta[TEST_STATUS] === 'pass')
            assert.strictEqual(passedFlakyTests.length, 4)
          })

        childProcess = exec(runTestsCommand, {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'ci-visibility/test-early-flake-detection/jest-parallel-snapshot',
            RUN_IN_PARALLEL: 'true',
            CI: '1', // needs to be run as CI so snapshots are not written
          },
        })

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })
    })

    it('does not flip exit code to 0 when a test suite fails to parse', async () => {
      receiver.setKnownTests({ jest: {} })
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: { '5s': 3 },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      // Scenario: (1) test-suite-failed-to-run-parse.js fails to parse,
      // (2) occasionally-failing-test is new, flaky (pass/fail alternates), EFD would ignore its failures.
      const testAssertionsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end')?.content
          assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true', 'EFD should be running')

          // TODO: parsing errors do not report test suite
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const occasionallyFailingTests = tests.filter(t => t.resource?.includes('occasionally-failing-test'))
          const numRetries = 3 // slow_test_retries: { '5s': 3 }
          assert.strictEqual(occasionallyFailingTests.length, 1 + numRetries, '1 original + 3 EFD retries')
          const efdRetried = occasionallyFailingTests.filter(t =>
            t.meta?.[TEST_IS_RETRY] === 'true' && t.meta?.[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd
          )
          assert.strictEqual(efdRetried.length, numRetries, 'all but 1 should have EFD retry tag and reason')
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: '(test-management/test-suite-failed-to-run-parse|' +
              'test-early-flake-detection/occasionally-failing-test)',
            SHOULD_CHECK_RESULTS: '1',
          },
        }
      )

      const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), testAssertionsPromise])
      assert.strictEqual(exitCode, 1, 'exit code 1 when test suite fails to parse')
    })

    it('does not flip exit code to 0 when a test suite fails due to module resolution error', async () => {
      receiver.setKnownTests({ jest: {} })
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: { '5s': 3 },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      // Scenario: (1) test-suite-failed-to-run-resolution.js fails to load,
      // (2) occasionally-failing-test is new, flaky, EFD would ignore its failures.
      const testAssertionsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end')?.content
          assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
          assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true', 'EFD should be running')

          const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
          const failedSuite = suites.find(s => s.meta?.[TEST_SUITE]?.includes('test-suite-failed-to-run-resolution'))
          assert.ok(failedSuite, 'failing test suite should be reported')
          assert.strictEqual(failedSuite.meta[TEST_STATUS], 'fail')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const occasionallyFailingTests = tests.filter(t => t.resource?.includes('occasionally-failing-test'))
          const numRetries = 3 // slow_test_retries: { '5s': 3 }
          assert.strictEqual(occasionallyFailingTests.length, 1 + numRetries, '1 original + 3 EFD retries')
          const efdRetried = occasionallyFailingTests.filter(t =>
            t.meta?.[TEST_IS_RETRY] === 'true' && t.meta?.[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd
          )
          assert.strictEqual(efdRetried.length, numRetries, 'all but 1 should have EFD retry tag and reason')
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: '(test-management/test-suite-failed-to-run-resolution|' +
              'test-early-flake-detection/occasionally-failing-test)',
            SHOULD_CHECK_RESULTS: '1',
          },
        }
      )

      const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), testAssertionsPromise])
      assert.strictEqual(exitCode, 1, 'exit code 1 when suite fails (resolution error, EFD)')
    })

    it('retries a fast new test using the count from the matching slow_test_retries bucket', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      receiver.setKnownTests({ jest: {} })
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 2,
            '10s': 1,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const testEvents = tests.filter(t => t.resource?.includes('instant-test'))
          // 1 original + 2 retries from the '5s' bucket (fast test < 5 s)
          assert.strictEqual(testEvents.length, 3)
          const efdRetries = testEvents.filter(t =>
            t.meta[TEST_IS_RETRY] === 'true' && t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd
          )
          assert.strictEqual(efdRetries.length, 2)
          testEvents.forEach(t => assert.strictEqual(t.meta[TEST_IS_NEW], 'true'))
        }, 30_000)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'test-early-flake-detection/instant-test',
          },
        }
      )

      await Promise.all([once(childProcess, 'exit'), eventsPromise])
    })

    it('retries a slightly slow new test using the count from the matching slow_test_retries bucket', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      receiver.setKnownTests({ jest: {} })
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 3,
            '10s': 1,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        // test runs for ~5100 ms × 2 executions; allow extra time for jest startup + reporting
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const testEvents = tests.filter(t => t.resource?.includes('slightly-slow-test'))
          // 1 original + 1 retry from the '10s' bucket (test takes ~5100 ms, between 5 s and 10 s)
          assert.strictEqual(testEvents.length, 2)
          const efdRetries = testEvents.filter(t =>
            t.meta[TEST_IS_RETRY] === 'true' && t.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd
          )
          assert.strictEqual(efdRetries.length, 1)
          testEvents.forEach(t => assert.strictEqual(t.meta[TEST_IS_NEW], 'true'))
        }, 30_000)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'test-early-flake-detection/slightly-slow-test',
          },
        }
      )

      await Promise.all([once(childProcess, 'exit'), eventsPromise])
    })

    it('aborts retries and tags the test when the test is too slow for any slow_test_retries bucket', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      receiver.setKnownTests({ jest: {} })
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 3,
            '10s': 0,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const testEvents = tests.filter(t => t.resource?.includes('slightly-slow-test'))
          // 0 retries — bucket value is 0
          assert.strictEqual(testEvents.length, 1)
          const [testEvent] = testEvents
          assert.strictEqual(testEvent.meta[TEST_IS_NEW], 'true')
          assert.strictEqual(testEvent.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'slow')
          assert.ok(!(TEST_IS_RETRY in testEvent.meta), 'should not be retried')
        }, 30_000)

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'test-early-flake-detection/slightly-slow-test',
          },
        }
      )

      await Promise.all([once(childProcess, 'exit'), eventsPromise])
    })

    it('tags new tests with dynamic names and logs a warning', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // No known tests, so both will be considered new
      receiver.setKnownTests({ jest: {} })
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: { '5s': 1 },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          // Deduplicate by test name (EFD retries produce multiple spans per test)
          const uniqueTests = new Map()
          for (const test of tests) {
            if (!uniqueTests.has(test.meta[TEST_NAME])) {
              uniqueTests.set(test.meta[TEST_NAME], test)
            }
          }

          const dynamicTests = [...uniqueTests.values()]
            .filter(test => test.meta[TEST_HAS_DYNAMIC_NAME] === 'true')
          // 8 dynamic tests: timestamp, localhost port, uuid, iso datetime,
          //   iso date-only, Math.random float, 127.0.0.1 port, 0.0.0.0 port
          assert.strictEqual(dynamicTests.length, 8)

          dynamicTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
          })

          // Verify each pattern type is detected
          const dynamicNames = dynamicTests.map(test => test.meta[TEST_NAME])
          assert.ok(dynamicNames.some(n => /can do stuff at \d+/.test(n)), 'timestamp test detected')
          assert.ok(dynamicNames.some(n => /localhost:\d+/.test(n)), 'localhost port test detected')
          assert.ok(dynamicNames.some(n => /user session [0-9a-f-]+/.test(n)), 'uuid test detected')
          assert.ok(dynamicNames.some(n => /created at \d{4}-\d{2}-\d{2}T/.test(n)), 'iso datetime test detected')
          assert.ok(dynamicNames.some(n => /event on \d{4}-\d{2}-\d{2}$/.test(n)), 'iso date-only test detected')
          assert.ok(dynamicNames.some(n => /probability 0\.\d+/.test(n)), 'Math.random float test detected')
          assert.ok(dynamicNames.some(n => /127\.0\.0\.1:\d+/.test(n)), '127.0.0.1 port test detected')
          assert.ok(dynamicNames.some(n => /0\.0\.0\.0:\d+/.test(n)), '0.0.0.0 port test detected')

          // The non-dynamic new tests should not have the tag
          const nonDynamicNewTests = [...uniqueTests.values()].filter(
            test => test.meta[TEST_IS_NEW] === 'true' && !test.meta[TEST_HAS_DYNAMIC_NAME]
          )
          nonDynamicNewTests.forEach(test => {
            assert.ok(!(TEST_HAS_DYNAMIC_NAME in test.meta))
          })
        })

      childProcess = fork(startupTestFile, {
        cwd,
        env: {
          ...getCiVisEvpProxyConfig(receiver.port),
          TESTS_TO_RUN: 'test/(dynamic-name-test|ci-visibility-test-2)',
        },
        stdio: 'pipe',
      })
      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })

      await Promise.all([once(childProcess, 'exit'), eventsPromise])

      assert.match(testOutput, /detected as new but their names contain dynamic data/)
      assert.match(testOutput, /can do stuff at/)
      assert.match(testOutput, /connects to localhost:/)
      assert.match(testOutput, /user session/)
      assert.match(testOutput, /created at/)
      assert.match(testOutput, /event on/)
      assert.match(testOutput, /probability 0\./)
      assert.match(testOutput, /server at 127\.0\.0\.1:/)
      assert.match(testOutput, /bound to 0\.0\.0\.0:/)
    })
  })

  context('flaky test retries', () => {
    it('sets final_status tag to test status reported to test framework on last retry', async () => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        flaky_test_retries_enabled: true,
        early_flake_detection: {
          enabled: false,
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          // test that passes without retry
          const passedWithoutRetry = tests.filter(test =>
            test.resource ===
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries will not retry passed tests'
          )[0]
          assert.strictEqual(passedWithoutRetry.meta[TEST_FINAL_STATUS], 'pass')

          // test that passes after second retry
          const eventuallyPassingTest = tests.filter(
            test => test.resource ===
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests'
          )
          eventuallyPassingTest.sort((a, b) =>
            (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)).forEach((test, index) => {
            if (index < eventuallyPassingTest.length - 1) {
              assert.ok(!(TEST_FINAL_STATUS in test.meta))
            } else {
              assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'pass')
            }
          })

          // test that fails on every retry
          const neverPassingTest = tests.filter(
            test => test.resource ===
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests'
          )
          neverPassingTest.sort((a, b) =>
            (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)).forEach((test, index) => {
            if (index < neverPassingTest.length - 1) {
              assert.ok(!(TEST_FINAL_STATUS in test.meta))
            } else {
              assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'fail')
            }
          })
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'jest-flaky/flaky-',
          },
          stdio: 'inherit',
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })

    it('retries failed tests automatically', (done) => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        flaky_test_retries_enabled: true,
        early_flake_detection: {
          enabled: false,
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.strictEqual(tests.length, 10)
          assertObjectContains(tests.map(test => test.resource), [
            // retries twice and passes
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests',
            // does not retry
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries will not retry passed tests',
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests',
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests',
            // retries twice and passes
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
            // retries up to 5 times and still fails
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
          ])

          const eventuallyPassingTest = tests.filter(
            test => test.resource ===
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests'
          )
          assert.strictEqual(eventuallyPassingTest.length, 3)
          assert.strictEqual(eventuallyPassingTest.filter(test => test.meta[TEST_STATUS] === 'fail').length, 2)
          assert.strictEqual(eventuallyPassingTest.filter(test => test.meta[TEST_STATUS] === 'pass').length, 1)
          assert.strictEqual(eventuallyPassingTest.filter(test => test.meta[TEST_IS_RETRY] === 'true').length, 2)
          assert.strictEqual(eventuallyPassingTest.filter(test =>
            test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          ).length, 2)

          const neverPassingTest = tests.filter(
            test => test.resource ===
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests'
          )
          assert.strictEqual(neverPassingTest.length, 6)
          assert.strictEqual(neverPassingTest.filter(test => test.meta[TEST_STATUS] === 'fail').length, 6)
          assert.strictEqual(neverPassingTest.filter(test => test.meta[TEST_STATUS] === 'pass').length, 0)
          assert.strictEqual(neverPassingTest.filter(test => test.meta[TEST_IS_RETRY] === 'true').length, 5)
          assert.strictEqual(neverPassingTest.filter(
            test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          ).length, 5)

          const testSuites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)

          const passingSuite = testSuites.find(
            suite => suite.resource === 'test_suite.ci-visibility/jest-flaky/flaky-passes.js'
          )
          assert.strictEqual(passingSuite.meta[TEST_STATUS], 'pass')

          const failedSuite = testSuites.find(
            suite => suite.resource === 'test_suite.ci-visibility/jest-flaky/flaky-fails.js'
          )
          assert.strictEqual(failedSuite.meta[TEST_STATUS], 'fail')
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'jest-flaky/flaky-',
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('is disabled if DD_CIVISIBILITY_FLAKY_RETRY_ENABLED is false', (done) => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        flaky_test_retries_enabled: true,
        early_flake_detection: {
          enabled: false,
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.strictEqual(tests.length, 3)
          assertObjectContains(tests.map(test => test.resource), [
            // does not retry anything
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests',
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries will not retry passed tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
          ])

          const retriedTests = tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)

          assert.strictEqual(retriedTests.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'jest-flaky/flaky-',
            DD_CIVISIBILITY_FLAKY_RETRY_ENABLED: 'false',
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('retries DD_CIVISIBILITY_FLAKY_RETRY_COUNT times', (done) => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        flaky_test_retries_enabled: true,
        early_flake_detection: {
          enabled: false,
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.strictEqual(tests.filter(test => test.meta[TEST_IS_RETRY] === 'true').length, 2)
          assert.strictEqual(
            tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr).length,
            2
          )

          assert.strictEqual(tests.length, 5)
          // only one retry
          assertObjectContains(tests.map(test => test.resource), [
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests',
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries will not retry passed tests',
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
          ])
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'jest-flaky/flaky-',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => done()).catch(done)
      })
    })

    it('sets TEST_HAS_FAILED_ALL_RETRIES when all ATR attempts fail', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Mark fail-test as known so EFD does not run; only ATR will retry
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test/fail-test.js': ['can report failed tests'],
        },
      })
      const NUM_RETRIES_ATR = 2
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        flaky_test_retries_count: NUM_RETRIES_ATR,
      })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const failTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/fail-test.js'
          )

          // Should have 1 initial attempt + NUM_RETRIES_ATR retries
          assert.strictEqual(failTests.length, NUM_RETRIES_ATR + 1)

          failTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
          })

          const retriedTests = failTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(retriedTests.length, NUM_RETRIES_ATR)
          retriedTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
          })

          // Only the last retry should have TEST_HAS_FAILED_ALL_RETRIES set
          const lastRetry = failTests[failTests.length - 1]
          assert.strictEqual(lastRetry.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')

          for (let i = 0; i < failTests.length - 1; i++) {
            assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in failTests[i].meta))
          }
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'test/fail-test',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: String(NUM_RETRIES_ATR),
          },
        }
      )

      await Promise.all([once(childProcess, 'exit'), eventsPromise])
    })
  })

  context('dynamic instrumentation', () => {
    onlyLatestIt('does not activate DI if DD_TEST_FAILED_TEST_REPLAY_ENABLED is set to false', (done) => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true,
      })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)

          assert.strictEqual(retriedTests.length, 1)
          const [retriedTest] = retriedTests

          const hasDebugTags = Object.keys(retriedTest.meta)
            .some(property => property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED)

          assert.strictEqual(hasDebugTags, false)
        })

      const logsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
          if (payloads.length > 0) {
            throw new Error('Unexpected logs')
          }
        }, 5000)

      childProcess = exec(runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'dynamic-instrumentation/test-hit-breakpoint',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            DD_TEST_FAILED_TEST_REPLAY_ENABLED: 'false',
          },
        }
      )

      childProcess.on('exit', (code) => {
        Promise.all([eventsPromise, logsPromise]).then(() => {
          assert.strictEqual(code, 0)
          done()
        }).catch(done)
      })
    })

    onlyLatestIt('does not activate DI if remote settings are disabled', (done) => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: false,
      })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)

          assert.strictEqual(retriedTests.length, 1)
          const [retriedTest] = retriedTests

          const hasDebugTags = Object.keys(retriedTest.meta)
            .some(property => property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED)

          assert.strictEqual(hasDebugTags, false)
        })
      const logsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
          if (payloads.length > 0) {
            throw new Error('Unexpected logs')
          }
        }, 5000)

      childProcess = exec(runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'dynamic-instrumentation/test-hit-breakpoint',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
          },
        }
      )

      childProcess.on('exit', (code) => {
        Promise.all([eventsPromise, logsPromise]).then(() => {
          assert.strictEqual(code, 0)
          done()
        }).catch(done)
      })
    })

    onlyLatestIt('runs retries with DI', (done) => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true,
      })
      let snapshotIdByTest, snapshotIdByLog
      let spanIdByTest, spanIdByLog, traceIdByTest, traceIdByLog
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)

          assert.strictEqual(retriedTests.length, 1)
          const [retriedTest] = retriedTests

          assert.strictEqual(retriedTest.meta[DI_ERROR_DEBUG_INFO_CAPTURED], 'true')

          assert.strictEqual(retriedTest.meta[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_FILE_SUFFIX}`]
            .endsWith('ci-visibility/dynamic-instrumentation/dependency.js'), true)
          assert.strictEqual(retriedTest.metrics[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_LINE_SUFFIX}`], 6)

          const snapshotIdKey = `${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX}`
          assert.ok(retriedTest.meta[snapshotIdKey])

          snapshotIdByTest = retriedTest.meta[snapshotIdKey]
          spanIdByTest = retriedTest.span_id.toString()
          traceIdByTest = retriedTest.trace_id.toString()

          const notRetriedTest = tests.find(test => test.meta[TEST_NAME].includes('is not retried'))

          assert.ok(!('DI_ERROR_DEBUG_INFO_CAPTURED' in notRetriedTest.meta))
        })

      const logsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
          const [{ logMessage: [diLog] }] = payloads
          assertObjectContains(diLog, {
            ddsource: 'dd_debugger',
            level: 'error',
          })
          assert.strictEqual(diLog.debugger.snapshot.language, 'javascript')
          assertObjectContains(diLog.debugger.snapshot.captures.lines['6'].locals, {
            a: {
              type: 'number',
              value: '11',
            },
            b: {
              type: 'number',
              value: '3',
            },
            localVariable: {
              type: 'number',
              value: '2',
            },
          })
          spanIdByLog = diLog.dd.span_id
          traceIdByLog = diLog.dd.trace_id
          snapshotIdByLog = diLog.debugger.snapshot.id
        })

      childProcess = exec(runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'dynamic-instrumentation/test-hit-breakpoint',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
          },
        }
      )

      childProcess.on('exit', () => {
        Promise.all([eventsPromise, logsPromise]).then(() => {
          assert.strictEqual(snapshotIdByTest, snapshotIdByLog)
          assert.strictEqual(spanIdByTest, spanIdByLog)
          assert.strictEqual(traceIdByTest, traceIdByLog)
          done()
        }).catch(done)
      })
    })

    onlyLatestIt('runs retries with DI in parallel mode', (done) => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true,
      })
      let snapshotIdByTest, snapshotIdByLog
      let spanIdByTest, spanIdByLog, traceIdByTest, traceIdByLog
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)

          assert.strictEqual(retriedTests.length, 1)
          const [retriedTest] = retriedTests

          assert.strictEqual(retriedTest.meta[DI_ERROR_DEBUG_INFO_CAPTURED], 'true')

          assert.strictEqual(retriedTest.meta[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_FILE_SUFFIX}`]
            .endsWith('ci-visibility/dynamic-instrumentation/dependency.js'), true)
          assert.strictEqual(retriedTest.metrics[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_LINE_SUFFIX}`], 6)

          const snapshotIdKey = `${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX}`
          assert.ok(retriedTest.meta[snapshotIdKey])

          snapshotIdByTest = retriedTest.meta[snapshotIdKey]
          spanIdByTest = retriedTest.span_id.toString()
          traceIdByTest = retriedTest.trace_id.toString()

          const notRetriedTest = tests.find(test => test.meta[TEST_NAME].includes('is not retried'))

          assert.ok(!('DI_ERROR_DEBUG_INFO_CAPTURED' in notRetriedTest.meta))
        })

      const logsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
          const [{ logMessage: [diLog] }] = payloads
          assertObjectContains(diLog, {
            ddsource: 'dd_debugger',
            level: 'error',
          })
          assert.ok(diLog.ddtags.includes('git.repository_url:'), `Got: ${inspect(diLog.ddtags)}`)
          assert.ok(diLog.ddtags.includes('git.commit.sha:'), `Got: ${inspect(diLog.ddtags)}`)
          assert.strictEqual(diLog.debugger.snapshot.language, 'javascript')
          assertObjectContains(diLog.debugger.snapshot.captures.lines['6'].locals, {
            a: {
              type: 'number',
              value: '11',
            },
            b: {
              type: 'number',
              value: '3',
            },
            localVariable: {
              type: 'number',
              value: '2',
            },
          })
          spanIdByLog = diLog.dd.span_id
          traceIdByLog = diLog.dd.trace_id
          snapshotIdByLog = diLog.debugger.snapshot.id
        })

      childProcess = exec(runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'dynamic-instrumentation/parallel-test-hit-breakpoint-',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            RUN_IN_PARALLEL: 'true',
          },
        }
      )

      childProcess.on('exit', () => {
        Promise.all([eventsPromise, logsPromise]).then(() => {
          assert.strictEqual(snapshotIdByTest, snapshotIdByLog)
          assert.strictEqual(spanIdByTest, spanIdByLog)
          assert.strictEqual(traceIdByTest, traceIdByLog)
          done()
        }).catch(done)
      })
    })

    onlyLatestIt('does not crash if the retry does not hit the breakpoint', (done) => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true,
      })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)

          assert.strictEqual(retriedTests.length, 1)
          const [retriedTest] = retriedTests

          const hasDebugTags = Object.keys(retriedTest.meta)
            .some(property => property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED)

          assert.strictEqual(hasDebugTags, false)
        })
      const logsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
          if (payloads.length > 0) {
            throw new Error('Unexpected logs')
          }
        }, 5000)

      childProcess = exec(runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'dynamic-instrumentation/test-not-hit-breakpoint',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
          },
        }
      )

      childProcess.on('exit', (code) => {
        Promise.all([eventsPromise, logsPromise]).then(() => {
          assert.strictEqual(code, 0)
          done()
        }).catch(done)
      })
    })

    onlyLatestIt('does not wait for breakpoint for a passed test', (done) => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)

          assert.strictEqual(retriedTests.length, 1)
          const [retriedTest] = retriedTests
          // Duration is in nanoseconds, so 200 * 1e6 is 200ms
          assert.strictEqual(retriedTest.duration < 200 * 1e6, true)
        })

      childProcess = exec(runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'dynamic-instrumentation/test-hit-breakpoint',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            TEST_SHOULD_PASS_AFTER_RETRY: '1',
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => done()).catch(done)
      })
    })
  })

  // This happens when using office-addin-mock
  context('a test imports a file whose name includes a library we should bypass jest require cache for', () => {
    it('does not crash', (done) => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        flaky_test_retries_enabled: false,
        early_flake_detection: {
          enabled: false,
        },
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.strictEqual(tests.length, 1)
        })

      childProcess = exec(runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'office-addin-mock/test',
          },
        }
      )

      childProcess.on('exit', (code) => {
        eventsPromise.then(() => {
          assert.strictEqual(code, 0)
          done()
        }).catch(done)
      })
    })
  })

  context('known tests without early flake detection', () => {
    it('detects new tests without retrying them', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
        },
      })
      receiver.setSettings({
        early_flake_detection: {
          enabled: false,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          // no other tests are considered new
          const oldTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test.js'
          )
          oldTests.forEach(test => {
            assert.ok(!(TEST_IS_NEW in test.meta))
          })
          assert.strictEqual(oldTests.length, 1)

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
          )
          newTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
          })
          const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // no test has been retried
          assert.strictEqual(retriedTests.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: { ...getCiVisEvpProxyConfig(receiver.port), TESTS_TO_RUN: 'test/ci-visibility-test' },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    // Regression test: without the fix, _ddKnownTests is not injected after worker restart,
    // so tests that should be detected as new are not marked as such.
    it('detects new tests after worker restart', async () => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests'],
        },
      })
      receiver.setSettings({
        early_flake_detection: {
          enabled: false,
        },
        known_tests_enabled: true,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const oldTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test.js'
          )
          oldTests.forEach(test => {
            assert.ok(!(TEST_IS_NEW in test.meta))
          })
          assert.strictEqual(oldTests.length, 1)

          // Tests from ci-visibility-test-2.js must still be detected as new
          // even when running on a restarted worker
          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
          )
          newTests.forEach(test => {
            assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
          })
          assert.strictEqual(newTests.length, 1)

          const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(retriedTests.length, 0)
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            // 4 suites: 2 spacers from test-management/ (sort first), then ci-visibility-test-2
            // and ci-visibility-test. The new test (ci-visibility-test-2) is the 3rd suite,
            // running on a child process that has been replaced twice by workerIdleMemoryLimit.
            TESTS_TO_RUN: '(test/ci-visibility-test|test-management/test-worker-restart-(spacer|known-tests-spacer))',
            RUN_IN_PARALLEL: 'true',
            MAX_WORKERS: '1',
            WORKER_IDLE_MEMORY_LIMIT: '0',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
    })
  })
})
