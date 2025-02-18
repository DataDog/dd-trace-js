'use strict'

const { fork, exec } = require('child_process')
const path = require('path')

const { assert } = require('chai')

const {
  createSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig
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
  TEST_SOURCE_FILE,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_NAME,
  JEST_DISPLAY_NAME,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_RETRY_REASON,
  TEST_SOURCE_START,
  TEST_CODE_OWNERS,
  TEST_SESSION_NAME,
  TEST_LEVEL_EVENT_TYPES,
  DI_ERROR_DEBUG_INFO_CAPTURED,
  DI_DEBUG_ERROR_PREFIX,
  DI_DEBUG_ERROR_FILE_SUFFIX,
  DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX,
  DI_DEBUG_ERROR_LINE_SUFFIX,
  DD_TEST_IS_USER_PROVIDED_SERVICE,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_QUARANTINED
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')
const { ERROR_MESSAGE } = require('../../packages/dd-trace/src/constants')

const testFile = 'ci-visibility/run-jest.js'
const expectedStdout = 'Test Suites: 2 passed'
const expectedCoverageFiles = [
  'ci-visibility/test/sum.js',
  'ci-visibility/test/ci-visibility-test.js',
  'ci-visibility/test/ci-visibility-test-2.js'
]
const runTestsWithCoverageCommand = 'node ./ci-visibility/run-jest.js'

// TODO: add ESM tests
describe('jest CommonJS', () => {
  let receiver
  let childProcess
  let sandbox
  let cwd
  let startupTestFile
  let testOutput = ''

  before(async function () {
    sandbox = await createSandbox([
      'jest',
      'chai@v4',
      'jest-jasmine2',
      'jest-environment-jsdom',
      'office-addin-mock'
    ], true)
    cwd = sandbox.folder
    startupTestFile = path.join(cwd, testFile)
  })

  after(async function () {
    await sandbox.remove()
  })

  beforeEach(async function () {
    receiver = await new FakeCiVisIntake().start()
  })

  afterEach(async () => {
    childProcess.kill()
    testOutput = ''
    await receiver.stop()
  })

  it('can run tests and report tests with the APM protocol (old agents)', (done) => {
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

      const areAllTestSpans = testSpans.every(span => span.name === 'jest.test')
      assert.isTrue(areAllTestSpans)

      assert.include(testOutput, expectedStdout)

      // Can read DD_TAGS
      testSpans.forEach(testSpan => {
        assert.propertyVal(testSpan.meta, 'test.customtag', 'customvalue')
        assert.propertyVal(testSpan.meta, 'test.customtag2', 'customvalue2')
      })

      testSpans.forEach(testSpan => {
        assert.equal(testSpan.meta[TEST_SOURCE_FILE].startsWith('ci-visibility/test/ci-visibility-test'), true)
        assert.exists(testSpan.metrics[TEST_SOURCE_START])
      })

      done()
    })

    childProcess = fork(startupTestFile, {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: receiver.port,
        NODE_OPTIONS: '-r dd-trace/ci/init',
        DD_TAGS: 'test.customtag:customvalue,test.customtag2:customvalue2'
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

  const nonLegacyReportingOptions = ['agentless', 'evp proxy']

  nonLegacyReportingOptions.forEach((reportingOption) => {
    it(`can run and report tests with ${reportingOption}`, (done) => {
      const envVars = reportingOption === 'agentless'
        ? getCiVisAgentlessConfig(receiver.port)
        : getCiVisEvpProxyConfig(receiver.port)
      if (reportingOption === 'evp proxy') {
        receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      }
      receiver.gatherPayloadsMaxTimeout(({ url }) => url.endsWith('citestcycle'), (payloads) => {
        const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

        metadataDicts.forEach(metadata => {
          for (const testLevel of TEST_LEVEL_EVENT_TYPES) {
            assert.equal(metadata[testLevel][TEST_SESSION_NAME], 'my-test-session')
          }
        })

        const events = payloads.flatMap(({ payload }) => payload.events)
        const sessionEventContent = events.find(event => event.type === 'test_session_end').content
        const moduleEventContent = events.find(event => event.type === 'test_module_end').content
        const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)

        const resourceNames = tests.map(span => span.resource)

        assert.includeMembers(resourceNames,
          [
            'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests',
            'ci-visibility/test/ci-visibility-test-2.js.ci visibility 2 can report tests 2'
          ]
        )
        assert.equal(suites.length, 2)
        assert.exists(sessionEventContent)
        assert.exists(moduleEventContent)

        assert.include(testOutput, expectedStdout)

        tests.forEach(testEvent => {
          assert.equal(testEvent.meta[TEST_SOURCE_FILE].startsWith('ci-visibility/test/ci-visibility-test'), true)
          assert.exists(testEvent.metrics[TEST_SOURCE_START])
          assert.equal(testEvent.meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'false')
          // Can read DD_TAGS
          assert.propertyVal(testEvent.meta, 'test.customtag', 'customvalue')
          assert.propertyVal(testEvent.meta, 'test.customtag2', 'customvalue2')
          assert.exists(testEvent.metrics[DD_HOST_CPU_COUNT])
        })

        suites.forEach(testSuite => {
          assert.isTrue(testSuite.meta[TEST_SOURCE_FILE].startsWith('ci-visibility/test/ci-visibility-test'))
          assert.equal(testSuite.metrics[TEST_SOURCE_START], 1)
          assert.exists(testSuite.metrics[DD_HOST_CPU_COUNT])
        })

        done()
      })

      childProcess = fork(startupTestFile, {
        cwd,
        env: {
          ...envVars,
          DD_TAGS: 'test.customtag:customvalue,test.customtag2:customvalue2',
          DD_TEST_SESSION_NAME: 'my-test-session',
          DD_SERVICE: undefined
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
  })

  const envVarSettings = ['DD_TRACING_ENABLED', 'DD_TRACE_ENABLED']

  envVarSettings.forEach(envVar => {
    context(`when ${envVar}=false`, () => {
      it('does not report spans but still runs tests', (done) => {
        receiver.assertMessageReceived(() => {
          done(new Error('Should not create spans'))
        }).catch(() => {})

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

  context('when no ci visibility init is used', () => {
    it('does not crash', (done) => {
      childProcess = fork(startupTestFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: receiver.port,
          NODE_OPTIONS: '-r dd-trace/init'
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
        assert.notInclude(testOutput, 'TypeError')
        assert.notInclude(testOutput, 'Uncaught error outside test suite')
        assert.include(testOutput, expectedStdout)
        done()
      })
    })
  })

  it('correctly calculates test code owners when working directory is not repository root', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)

        const test = events.find(event => event.type === 'test').content
        const testSuite = events.find(event => event.type === 'test_suite_end').content
        // The test is in a subproject
        assert.notEqual(test.meta[TEST_SOURCE_FILE], test.meta[TEST_SUITE])
        assert.equal(test.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
        assert.equal(testSuite.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
      })

    childProcess = exec(
      'node ./node_modules/jest/bin/jest --config config-jest.js --rootDir ci-visibility/subproject',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          PROJECTS: JSON.stringify([{
            testMatch: ['**/subproject-test*']
          }])
        },
        stdio: 'inherit'
      }
    )

    childProcess.on('exit', () => {
      eventsPromise.then(() => {
        done()
      }).catch(done)
    })
  })

  it('works when sharding', (done) => {
    receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle').then(events => {
      const testSuiteEvents = events.payload.events.filter(event => event.type === 'test_suite_end')
      assert.equal(testSuiteEvents.length, 3)
      const testSuites = testSuiteEvents.map(span => span.content.meta[TEST_SUITE])

      assert.includeMembers(testSuites,
        [
          'ci-visibility/sharding-test/sharding-test-5.js',
          'ci-visibility/sharding-test/sharding-test-4.js',
          'ci-visibility/sharding-test/sharding-test-1.js'
        ]
      )

      const testSession = events.payload.events.find(event => event.type === 'test_session_end').content
      assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'false')

      // We run the second shard
      receiver.setSuitesToSkip([
        {
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/sharding-test/sharding-test-2.js'
          }
        },
        {
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/sharding-test/sharding-test-3.js'
          }
        }
      ])
      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'sharding-test/sharding-test',
            TEST_SHARD: '2/2'
          },
          stdio: 'inherit'
        }
      )

      receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle').then(secondShardEvents => {
        const testSuiteEvents = secondShardEvents.payload.events.filter(event => event.type === 'test_suite_end')

        // The suites for this shard are to be skipped
        assert.equal(testSuiteEvents.length, 2)

        testSuiteEvents.forEach(testSuite => {
          assert.propertyVal(testSuite.content.meta, TEST_STATUS, 'skip')
          assert.propertyVal(testSuite.content.meta, TEST_SKIPPED_BY_ITR, 'true')
        })

        const testSession = secondShardEvents
          .payload
          .events
          .find(event => event.type === 'test_session_end').content

        assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'true')
        assert.propertyVal(testSession.meta, TEST_ITR_SKIPPING_TYPE, 'suite')
        assert.propertyVal(testSession.metrics, TEST_ITR_SKIPPING_COUNT, 2)

        done()
      })
    })
    childProcess = exec(
      runTestsWithCoverageCommand,
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: 'sharding-test/sharding-test',
          TEST_SHARD: '1/2'
        },
        stdio: 'inherit'
      }
    )
  })

  it('does not crash when jest is badly initialized', (done) => {
    childProcess = fork('ci-visibility/run-jest-bad-init.js', {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: receiver.port
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
      assert.notInclude(testOutput, 'TypeError')
      assert.include(testOutput, expectedStdout)
      done()
    })
  })

  it('does not crash when jest uses jest-jasmine2', (done) => {
    childProcess = fork(testFile, {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        OLD_RUNNER: 1,
        NODE_OPTIONS: '-r dd-trace/ci/init',
        RUN_IN_PARALLEL: true
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
      assert.notInclude(testOutput, 'TypeError')
      done()
    })
  })

  context('when jest is using workers to run tests in parallel', () => {
    it('reports tests when using the old agents', (done) => {
      receiver.setInfoResponse({ endpoints: [] })
      childProcess = fork(testFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: receiver.port,
          NODE_OPTIONS: '-r dd-trace/ci/init',
          RUN_IN_PARALLEL: true
        },
        stdio: 'pipe'
      })

      receiver.gatherPayloads(({ url }) => url === '/v0.4/traces', 5000).then(tracesRequests => {
        const testSpans = tracesRequests.flatMap(trace => trace.payload).flatMap(request => request)
        assert.equal(testSpans.length, 2)
        const spanTypes = testSpans.map(span => span.type)
        assert.includeMembers(spanTypes, ['test'])
        assert.notInclude(spanTypes, ['test_session_end', 'test_suite_end', 'test_module_end'])
        receiver.setInfoResponse({ endpoints: ['/evp_proxy/v2'] })
        done()
      }).catch(done)
    })

    it('reports tests when using agentless', (done) => {
      childProcess = fork(testFile, {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          RUN_IN_PARALLEL: true,
          DD_TEST_SESSION_NAME: 'my-test-session'
        },
        stdio: 'pipe'
      })

      receiver.gatherPayloads(({ url }) => url === '/api/v2/citestcycle', 5000).then(eventsRequests => {
        const metadataDicts = eventsRequests.flatMap(({ payload }) => payload.metadata)

        // it propagates test session name to the test and test suite events in parallel mode
        metadataDicts.forEach(metadata => {
          for (const testLevel of TEST_LEVEL_EVENT_TYPES) {
            assert.equal(metadata[testLevel][TEST_SESSION_NAME], 'my-test-session')
          }
        })

        const events = eventsRequests.map(({ payload }) => payload)
          .flatMap(({ events }) => events)
        const eventTypes = events.map(event => event.type)
        assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])

        done()
      }).catch(done)
    })

    it('reports tests when using evp proxy', (done) => {
      childProcess = fork(testFile, {
        cwd,
        env: {
          ...getCiVisEvpProxyConfig(receiver.port),
          RUN_IN_PARALLEL: true
        },
        stdio: 'pipe'
      })

      receiver.gatherPayloads(({ url }) => url === '/evp_proxy/v2/api/v2/citestcycle', 5000)
        .then(eventsRequests => {
          const eventTypes = eventsRequests.map(({ payload }) => payload)
            .flatMap(({ events }) => events)
            .map(event => event.type)

          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
          done()
        }).catch(done)
    })

    it('can work with Dynamic Instrumentation', (done) => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true
      })
      let snapshotIdByTest, snapshotIdByLog
      let spanIdByTest, spanIdByLog, traceIdByTest, traceIdByLog
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

          assert.equal(retriedTests.length, 2)
          const retriedTest = retriedTests.find(test => test.meta[TEST_SUITE].includes('test-hit-breakpoint.js'))

          assert.propertyVal(retriedTest.meta, DI_ERROR_DEBUG_INFO_CAPTURED, 'true')

          assert.isTrue(
            retriedTest.meta[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_FILE_SUFFIX}`]
              .endsWith('ci-visibility/dynamic-instrumentation/dependency.js')
          )
          assert.equal(retriedTest.metrics[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_LINE_SUFFIX}`], 4)

          const snapshotIdKey = `${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX}`
          assert.exists(retriedTest.meta[snapshotIdKey])

          snapshotIdByTest = retriedTest.meta[snapshotIdKey]
          spanIdByTest = retriedTest.span_id.toString()
          traceIdByTest = retriedTest.trace_id.toString()

          const notRetriedTest = tests.find(test => test.meta[TEST_NAME].includes('is not retried'))

          assert.notProperty(notRetriedTest.meta, DI_ERROR_DEBUG_INFO_CAPTURED)
        })

      const logsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
          const [{ logMessage: [diLog] }] = payloads
          assert.deepInclude(diLog, {
            ddsource: 'dd_debugger',
            level: 'error'
          })
          assert.equal(diLog.debugger.snapshot.language, 'javascript')
          spanIdByLog = diLog.dd.span_id
          traceIdByLog = diLog.dd.trace_id
          snapshotIdByLog = diLog.debugger.snapshot.id
        })

      childProcess = exec(runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'dynamic-instrumentation/test-',
            DD_TEST_DYNAMIC_INSTRUMENTATION_ENABLED: 'true',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            RUN_IN_PARALLEL: true
          },
          stdio: 'inherit'
        }
      )

      childProcess.on('exit', () => {
        Promise.all([eventsPromise, logsPromise]).then(() => {
          assert.equal(snapshotIdByTest, snapshotIdByLog)
          assert.equal(spanIdByTest, spanIdByLog)
          assert.equal(traceIdByTest, traceIdByLog)
          done()
        }).catch(done)
      })
    })
  })

  it('reports timeout error message', (done) => {
    childProcess = fork(testFile, {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        NODE_OPTIONS: '-r dd-trace/ci/init',
        RUN_IN_PARALLEL: true,
        TESTS_TO_RUN: 'timeout-test/timeout-test.js'
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
      assert.include(testOutput, 'Exceeded timeout of 100 ms for a test')
      done()
    })
  })

  it('reports parsing errors in the test file', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const suites = events.filter(event => event.type === 'test_suite_end')
        assert.equal(suites.length, 2)

        const resourceNames = suites.map(suite => suite.content.resource)

        assert.includeMembers(resourceNames, [
          'test_suite.ci-visibility/test-parsing-error/parsing-error-2.js',
          'test_suite.ci-visibility/test-parsing-error/parsing-error.js'
        ])
        suites.forEach(suite => {
          assert.equal(suite.content.meta[TEST_STATUS], 'fail')
          assert.include(suite.content.meta[ERROR_MESSAGE], 'chao')
        })
      })
    childProcess = fork(testFile, {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        TESTS_TO_RUN: 'test-parsing-error/parsing-error'
      },
      stdio: 'pipe'
    })
    childProcess.on('exit', () => {
      eventsPromise.then(() => {
        done()
      }).catch(done)
    })
  })

  it('does not report total code coverage % if user has not configured coverage manually', (done) => {
    receiver.setSettings({
      itr_enabled: true,
      code_coverage: true,
      tests_skipping: false
    })

    receiver.assertPayloadReceived(({ payload }) => {
      const testSession = payload.events.find(event => event.type === 'test_session_end').content
      assert.notProperty(testSession.metrics, TEST_CODE_COVERAGE_LINES_PCT)
    }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

    childProcess = exec(
      runTestsWithCoverageCommand,
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          DISABLE_CODE_COVERAGE: '1'
        },
        stdio: 'inherit'
      }
    )
  })

  it('reports total code coverage % even when ITR is disabled', (done) => {
    receiver.setSettings({
      itr_enabled: false,
      code_coverage: false,
      tests_skipping: false
    })

    receiver.assertPayloadReceived(({ payload }) => {
      const testSession = payload.events.find(event => event.type === 'test_session_end').content
      assert.exists(testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT])
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

  it('works with --forceExit and logs a warning', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        assert.include(testOutput, "Jest's '--forceExit' flag has been passed")
        const events = payloads.flatMap(({ payload }) => payload.events)

        const testSession = events.find(event => event.type === 'test_session_end')
        const testModule = events.find(event => event.type === 'test_module_end')
        const testSuites = events.filter(event => event.type === 'test_suite_end')
        const tests = events.filter(event => event.type === 'test')

        assert.exists(testSession)
        assert.exists(testModule)
        assert.equal(testSuites.length, 2)
        assert.equal(tests.length, 2)
      })
    // Needs to run with the CLI if we want --forceExit to work
    childProcess = exec(
      'node ./node_modules/jest/bin/jest --config config-jest.js --forceExit',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          DD_TRACE_DEBUG: '1',
          DD_TRACE_LOG_LEVEL: 'warn'
        },
        stdio: 'inherit'
      }
    )
    childProcess.on('exit', () => {
      eventsPromise.then(() => {
        done()
      }).catch(done)
    })
    childProcess.stdout.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
  })

  it('does not hang if server is not available and logs an error', (done) => {
    // Very slow intake
    receiver.setWaitingTime(30000)
    // Needs to run with the CLI if we want --forceExit to work
    childProcess = exec(
      'node ./node_modules/jest/bin/jest --config config-jest.js --forceExit',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          DD_TRACE_DEBUG: '1',
          DD_TRACE_LOG_LEVEL: 'warn'
        },
        stdio: 'inherit'
      }
    )
    const EXPECTED_FORCE_EXIT_LOG_MESSAGE = "Jest's '--forceExit' flag has been passed"
    const EXPECTED_TIMEOUT_LOG_MESSAGE = 'Timeout waiting for the tracer to flush'
    childProcess.on('exit', () => {
      assert.include(
        testOutput,
        EXPECTED_FORCE_EXIT_LOG_MESSAGE,
        `"${EXPECTED_FORCE_EXIT_LOG_MESSAGE}" log message is not in test output: ${testOutput}`
      )
      assert.include(
        testOutput,
        EXPECTED_TIMEOUT_LOG_MESSAGE,
        `"${EXPECTED_TIMEOUT_LOG_MESSAGE}" log message is not in the test output: ${testOutput}`
      )
      done()
    })
    childProcess.stdout.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
  })

  it('grabs the jest displayName config and sets tag in tests and suites', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)
        assert.equal(tests.length, 4) // two per display name
        const nodeTests = tests.filter(test => test.meta[JEST_DISPLAY_NAME] === 'node')
        assert.equal(nodeTests.length, 2)

        const standardTests = tests.filter(test => test.meta[JEST_DISPLAY_NAME] === 'standard')
        assert.equal(standardTests.length, 2)

        const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
        assert.equal(suites.length, 4)

        const nodeSuites = suites.filter(suite => suite.meta[JEST_DISPLAY_NAME] === 'node')
        assert.equal(nodeSuites.length, 2)

        const standardSuites = suites.filter(suite => suite.meta[JEST_DISPLAY_NAME] === 'standard')
        assert.equal(standardSuites.length, 2)
      })
    childProcess = exec(
      'node ./node_modules/jest/bin/jest --config config-jest-multiproject.js',
      {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
        stdio: 'inherit'
      }
    )
    childProcess.on('exit', () => {
      eventsPromise.then(() => {
        done()
      }).catch(done)
    })
  })

  it('reports errors in test sessions', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testSession = events.find(event => event.type === 'test_session_end').content
        assert.propertyVal(testSession.meta, TEST_STATUS, 'fail')
        const errorMessage = 'Failed test suites: 1. Failed tests: 1'
        assert.include(testSession.meta[ERROR_MESSAGE], errorMessage)
      })

    childProcess = exec(
      runTestsWithCoverageCommand,
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: 'test/fail-test'
        },
        stdio: 'inherit'
      }
    )
    childProcess.on('exit', () => {
      eventsPromise.then(() => {
        done()
      }).catch(done)
    })
  })

  it('does not init if DD_API_KEY is not set', (done) => {
    receiver.assertMessageReceived(() => {
      done(new Error('Should not create spans'))
    }).catch(() => {})

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
      assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
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
    it('can report code coverage', (done) => {
      const libraryConfigRequestPromise = receiver.payloadReceived(
        ({ url }) => url === '/api/v2/libraries/tests/services/setting'
      )
      const codeCovRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcov')
      const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle')

      Promise.all([
        libraryConfigRequestPromise,
        codeCovRequestPromise,
        eventsRequestPromise
      ]).then(([libraryConfigRequest, codeCovRequest, eventsRequest]) => {
        assert.propertyVal(libraryConfigRequest.headers, 'dd-api-key', '1')

        const [coveragePayload] = codeCovRequest.payload
        assert.propertyVal(codeCovRequest.headers, 'dd-api-key', '1')

        assert.propertyVal(coveragePayload, 'name', 'coverage1')
        assert.propertyVal(coveragePayload, 'filename', 'coverage1.msgpack')
        assert.propertyVal(coveragePayload, 'type', 'application/msgpack')
        assert.include(coveragePayload.content, {
          version: 2
        })
        const allCoverageFiles = codeCovRequest.payload
          .flatMap(coverage => coverage.content.coverages)
          .flatMap(file => file.files)
          .map(file => file.filename)

        assert.includeMembers(allCoverageFiles, expectedCoverageFiles)
        assert.exists(coveragePayload.content.coverages[0].test_session_id)
        assert.exists(coveragePayload.content.coverages[0].test_suite_id)

        const testSession = eventsRequest.payload.events.find(event => event.type === 'test_session_end').content
        assert.exists(testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT])

        const eventTypes = eventsRequest.payload.events.map(event => event.type)
        assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
        const numSuites = eventTypes.reduce(
          (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
        )
        assert.equal(numSuites, 2)
      }).catch(done)

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
          stdio: 'pipe'
        }
      )
      childProcess.stdout.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.on('exit', () => {
        done()
      })
    })

    it('does not report code coverage if disabled by the API', (done) => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false
      })

      receiver.assertPayloadReceived(() => {
        const error = new Error('it should not report code coverage')
        done(error)
      }, ({ url }) => url === '/api/v2/citestcov').catch(() => {})

      receiver.assertPayloadReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'dd-api-key', '1')
        const eventTypes = payload.events.map(event => event.type)
        assert.includeMembers(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
        const testSession = payload.events.find(event => event.type === 'test_session_end').content
        assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'false')
        assert.propertyVal(testSession.meta, TEST_CODE_COVERAGE_ENABLED, 'false')
        assert.propertyVal(testSession.meta, TEST_ITR_SKIPPING_ENABLED, 'false')
        assert.exists(testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT])
        const testModule = payload.events.find(event => event.type === 'test_module_end').content
        assert.propertyVal(testModule.meta, TEST_ITR_TESTS_SKIPPED, 'false')
        assert.propertyVal(testModule.meta, TEST_CODE_COVERAGE_ENABLED, 'false')
        assert.propertyVal(testModule.meta, TEST_ITR_SKIPPING_ENABLED, 'false')
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
        const [coveragePayload] = coverageRequest.payload
        assert.propertyVal(coverageRequest.headers, 'dd-api-key', '1')
        assert.propertyVal(coveragePayload, 'name', 'coverage1')
        assert.propertyVal(coveragePayload, 'filename', 'coverage1.msgpack')
        assert.propertyVal(coveragePayload, 'type', 'application/msgpack')

        assert.propertyVal(eventsRequest.headers, 'dd-api-key', '1')
        const eventTypes = eventsRequest.payload.events.map(event => event.type)
        const skippedSuite = eventsRequest.payload.events.find(event =>
          event.content.resource === 'test_suite.ci-visibility/test/ci-visibility-test.js'
        ).content
        assert.propertyVal(skippedSuite.meta, TEST_STATUS, 'skip')
        assert.propertyVal(skippedSuite.meta, TEST_SKIPPED_BY_ITR, 'true')

        assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
        const numSuites = eventTypes.reduce(
          (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
        )
        assert.equal(numSuites, 2)
        const testSession = eventsRequest.payload.events.find(event => event.type === 'test_session_end').content
        assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'true')
        assert.propertyVal(testSession.meta, TEST_CODE_COVERAGE_ENABLED, 'true')
        assert.propertyVal(testSession.meta, TEST_ITR_SKIPPING_ENABLED, 'true')
        assert.propertyVal(testSession.meta, TEST_ITR_SKIPPING_TYPE, 'suite')
        assert.propertyVal(testSession.metrics, TEST_ITR_SKIPPING_COUNT, 1)
        const testModule = eventsRequest.payload.events.find(event => event.type === 'test_module_end').content
        assert.propertyVal(testModule.meta, TEST_ITR_TESTS_SKIPPED, 'true')
        assert.propertyVal(testModule.meta, TEST_CODE_COVERAGE_ENABLED, 'true')
        assert.propertyVal(testModule.meta, TEST_ITR_SKIPPING_ENABLED, 'true')
        assert.propertyVal(testModule.meta, TEST_ITR_SKIPPING_TYPE, 'suite')
        assert.propertyVal(testModule.metrics, TEST_ITR_SKIPPING_COUNT, 1)
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

    it('marks the test session as skipped if every suite is skipped', (done) => {
      receiver.setSuitesToSkip(
        [
          {
            type: 'suite',
            attributes: {
              suite: 'ci-visibility/test/ci-visibility-test.js'
            }
          },
          {
            type: 'suite',
            attributes: {
              suite: 'ci-visibility/test/ci-visibility-test-2.js'
            }
          }
        ]
      )

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.propertyVal(testSession.meta, TEST_STATUS, 'skip')
        })
      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
          stdio: 'inherit'
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
          suite: 'ci-visibility/test/ci-visibility-test.js'
        }
      }])

      receiver.setGitUploadStatus(404)

      receiver.assertPayloadReceived(() => {
        const error = new Error('should not request skippable')
        done(error)
      }, ({ url }) => url === '/api/v2/ci/tests/skippable').catch(() => {})

      receiver.assertPayloadReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'dd-api-key', '1')
        const eventTypes = payload.events.map(event => event.type)
        // because they are not skipped
        assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
        const numSuites = eventTypes.reduce(
          (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
        )
        assert.equal(numSuites, 2)
        const testSession = payload.events.find(event => event.type === 'test_session_end').content
        assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'false')
        assert.propertyVal(testSession.meta, TEST_CODE_COVERAGE_ENABLED, 'true')
        assert.propertyVal(testSession.meta, TEST_ITR_SKIPPING_ENABLED, 'true')
        const testModule = payload.events.find(event => event.type === 'test_module_end').content
        assert.propertyVal(testModule.meta, TEST_ITR_TESTS_SKIPPED, 'false')
        assert.propertyVal(testModule.meta, TEST_CODE_COVERAGE_ENABLED, 'true')
        assert.propertyVal(testModule.meta, TEST_ITR_SKIPPING_ENABLED, 'true')
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
        itr_enabled: true,
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
      }, ({ url }) => url === '/api/v2/ci/tests/skippable').catch(() => {})

      receiver.assertPayloadReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'dd-api-key', '1')
        const eventTypes = payload.events.map(event => event.type)
        // because they are not skipped
        assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
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

    it('does not skip suites if suite is marked as unskippable', (done) => {
      receiver.setSuitesToSkip([
        {
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/unskippable-test/test-to-skip.js'
          }
        },
        {
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/unskippable-test/test-unskippable.js'
          }
        }
      ])

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const suites = events.filter(event => event.type === 'test_suite_end')

          assert.equal(suites.length, 3)

          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content
          assert.propertyVal(testSession.meta, TEST_ITR_FORCED_RUN, 'true')
          assert.propertyVal(testSession.meta, TEST_ITR_UNSKIPPABLE, 'true')
          assert.propertyVal(testModule.meta, TEST_ITR_FORCED_RUN, 'true')
          assert.propertyVal(testModule.meta, TEST_ITR_UNSKIPPABLE, 'true')

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
          assert.propertyVal(passedSuite.content.meta, TEST_STATUS, 'pass')
          assert.notProperty(passedSuite.content.meta, TEST_ITR_UNSKIPPABLE)
          assert.notProperty(passedSuite.content.meta, TEST_ITR_FORCED_RUN)

          assert.propertyVal(skippedSuite.content.meta, TEST_STATUS, 'skip')
          assert.notProperty(skippedSuite.content.meta, TEST_ITR_UNSKIPPABLE)
          assert.notProperty(skippedSuite.content.meta, TEST_ITR_FORCED_RUN)

          assert.propertyVal(forcedToRunSuite.content.meta, TEST_STATUS, 'pass')
          assert.propertyVal(forcedToRunSuite.content.meta, TEST_ITR_UNSKIPPABLE, 'true')
          assert.propertyVal(forcedToRunSuite.content.meta, TEST_ITR_FORCED_RUN, 'true')
        }, 25000)

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'unskippable-test/test-'
          },
          stdio: 'inherit'
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('only sets forced to run if suite was going to be skipped by ITR', (done) => {
      receiver.setSuitesToSkip([
        {
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/unskippable-test/test-to-skip.js'
          }
        }
      ])

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const suites = events.filter(event => event.type === 'test_suite_end')

          assert.equal(suites.length, 3)

          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content
          assert.notProperty(testSession.meta, TEST_ITR_FORCED_RUN)
          assert.propertyVal(testSession.meta, TEST_ITR_UNSKIPPABLE, 'true')
          assert.notProperty(testModule.meta, TEST_ITR_FORCED_RUN)
          assert.propertyVal(testModule.meta, TEST_ITR_UNSKIPPABLE, 'true')

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
          assert.propertyVal(passedSuite.content.meta, TEST_STATUS, 'pass')
          assert.notProperty(passedSuite.content.meta, TEST_ITR_UNSKIPPABLE)
          assert.notProperty(passedSuite.content.meta, TEST_ITR_FORCED_RUN)

          assert.propertyVal(skippedSuite.meta, TEST_STATUS, 'skip')

          assert.propertyVal(nonSkippedSuite.meta, TEST_STATUS, 'pass')
          assert.propertyVal(nonSkippedSuite.meta, TEST_ITR_UNSKIPPABLE, 'true')
          // it was not forced to run because it wasn't going to be skipped
          assert.notProperty(nonSkippedSuite.meta, TEST_ITR_FORCED_RUN)
        }, 25000)

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'unskippable-test/test-'
          },
          stdio: 'inherit'
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
          suite: 'ci-visibility/test/not-existing-test.js'
        }
      }])
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'false')
          assert.propertyVal(testSession.meta, TEST_CODE_COVERAGE_ENABLED, 'true')
          assert.propertyVal(testSession.meta, TEST_ITR_SKIPPING_ENABLED, 'true')
          const testModule = events.find(event => event.type === 'test_module_end').content
          assert.propertyVal(testModule.meta, TEST_ITR_TESTS_SKIPPED, 'false')
          assert.propertyVal(testModule.meta, TEST_CODE_COVERAGE_ENABLED, 'true')
          assert.propertyVal(testModule.meta, TEST_ITR_SKIPPING_ENABLED, 'true')
        }, 25000)

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
          stdio: 'inherit'
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
            assert.equal(testSuite.itr_correlation_id, itrCorrelationId)
          })
        }, 25000)
      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
          stdio: 'inherit'
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('can skip when using a custom test sequencer', (done) => {
      receiver.setSettings({
        itr_enabled: true,
        tests_skipping: true
      })
      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: {
          suite: 'ci-visibility/test/ci-visibility-test.js'
        }
      }])

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testEvents = events.filter(event => event.type === 'test')
          // no tests end up running (suite is skipped)
          assert.equal(testEvents.length, 0)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.propertyVal(testSession.meta, TEST_ITR_TESTS_SKIPPED, 'true')

          const skippedSuite = events.find(event =>
            event.content.resource === 'test_suite.ci-visibility/test/ci-visibility-test.js'
          ).content
          assert.propertyVal(skippedSuite.meta, TEST_STATUS, 'skip')
          assert.propertyVal(skippedSuite.meta, TEST_SKIPPED_BY_ITR, 'true')
        })
      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            CUSTOM_TEST_SEQUENCER: './ci-visibility/jest-custom-test-sequencer.js',
            TEST_SHARD: '2/2'
          },
          stdio: 'inherit'
        }
      )
      childProcess.stdout.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr.on('data', (chunk) => {
        testOutput += chunk.toString()
      })

      childProcess.on('exit', () => {
        assert.include(testOutput, 'Running shard with a custom sequencer')
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('works with multi project setup and test skipping', (done) => {
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: true,
        tests_skipping: true
      })

      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: {
          suite: 'ci-visibility/test/ci-visibility-test.js'
        }
      }])

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          // suites for both projects in the multi-project config are reported as skipped
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSuites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)

          const skippedSuites = testSuites.filter(
            suite => suite.resource === 'test_suite.ci-visibility/test/ci-visibility-test.js'
          )
          assert.equal(skippedSuites.length, 2)

          skippedSuites.forEach(skippedSuite => {
            assert.equal(skippedSuite.meta[TEST_STATUS], 'skip')
            assert.equal(skippedSuite.meta[TEST_SKIPPED_BY_ITR], 'true')
          })
        })

      childProcess = exec(
        'node ./node_modules/jest/bin/jest --config config-jest-multiproject.js',
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
          stdio: 'inherit'
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('calculates executable lines even if there have been skipped suites', (done) => {
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: true,
        tests_skipping: true
      })

      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: {
          suite: 'ci-visibility/test-total-code-coverage/test-skipped.js'
        }
      }])

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end').content

          // Before https://github.com/DataDog/dd-trace-js/pull/4336, this would've been 100%
          // The reason is that skipping jest's `addUntestedFiles`, we would not see unexecuted lines.
          // In this cause, these would be from the `unused-dependency.js` file.
          // It is 50% now because we only cover 1 out of 2 files (`used-dependency.js`).
          assert.propertyVal(testSession.metrics, TEST_CODE_COVERAGE_LINES_PCT, 50)
        })

      childProcess = exec(
        runTestsWithCoverageCommand, // Requirement: the user must've opted in to code coverage
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'ci-visibility/test-total-code-coverage/test-',
            COLLECT_COVERAGE_FROM: '**/test-total-code-coverage/**'
          },
          stdio: 'inherit'
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(done).catch(done)
      })
    })

    it('reports code coverage relative to the repository root, not working directory', (done) => {
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: true,
        tests_skipping: false
      })

      const codeCoveragesPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcov'), (payloads) => {
          const coveredFiles = payloads
            .flatMap(({ payload }) => payload)
            .flatMap(({ content: { coverages } }) => coverages)
            .flatMap(({ files }) => files)
            .map(({ filename }) => filename)

          assert.includeMembers(coveredFiles, [
            'ci-visibility/subproject/dependency.js',
            'ci-visibility/subproject/subproject-test.js'
          ])
        }, 5000)

      childProcess = exec(
        'node ./node_modules/jest/bin/jest --config config-jest.js --rootDir ci-visibility/subproject',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            PROJECTS: JSON.stringify([{
              testMatch: ['**/subproject-test*']
            }])
          },
          stdio: 'inherit'
        }
      )

      childProcess.on('exit', () => {
        codeCoveragesPromise.then(() => {
          done()
        }).catch(done)
      })
    })
  })

  context('early flake detection', () => {
    it('retries new tests', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests']
        }
      })
      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD
          },
          faulty_session_threshold: 100
        },
        known_tests_enabled: true
      })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          // TODO: maybe check in stdout for the "Retried by Datadog"
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          // no other tests are considered new
          const oldTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test.js'
          )
          oldTests.forEach(test => {
            assert.notProperty(test.meta, TEST_IS_NEW)
          })
          assert.equal(oldTests.length, 1)

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
          )
          newTests.forEach(test => {
            assert.propertyVal(test.meta, TEST_IS_NEW, 'true')
          })
          const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // all but one has been retried
          assert.equal(
            newTests.length - 1,
            retriedTests.length
          )
          assert.equal(retriedTests.length, NUM_RETRIES_EFD)
          retriedTests.forEach(test => {
            assert.propertyVal(test.meta, TEST_RETRY_REASON, 'efd')
          })
          // Test name does not change
          newTests.forEach(test => {
            assert.equal(test.meta[TEST_NAME], 'ci visibility 2 can report tests 2')
          })
        })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: { ...getCiVisEvpProxyConfig(receiver.port), TESTS_TO_RUN: 'test/ci-visibility-test' },
          stdio: 'inherit'
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('handles parameterized tests as a single unit', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test-early-flake-detection/test-parameterized.js will be considered new
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test-early-flake-detection/test.js': ['ci visibility can report tests']
        }
      })
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 3
          },
          faulty_session_threshold: 100
        },
        known_tests_enabled: true
      })

      const parameterizedTestFile = 'test-parameterized.js'

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === `ci-visibility/test-early-flake-detection/${parameterizedTestFile}`
          )
          newTests.forEach(test => {
            assert.propertyVal(test.meta, TEST_IS_NEW, 'true')
          })
          // Each parameter is repeated independently
          const testsForFirstParameter = tests.filter(test => test.resource ===
            `ci-visibility/test-early-flake-detection/${parameterizedTestFile}.parameterized test parameter 1`
          )

          const testsForSecondParameter = tests.filter(test => test.resource ===
            `ci-visibility/test-early-flake-detection/${parameterizedTestFile}.parameterized test parameter 2`
          )

          assert.equal(testsForFirstParameter.length, testsForSecondParameter.length)

          // all but one have been retried
          assert.equal(
            testsForFirstParameter.length - 1,
            testsForFirstParameter.filter(test => test.meta[TEST_IS_RETRY] === 'true').length
          )

          assert.equal(
            testsForSecondParameter.length - 1,
            testsForSecondParameter.filter(test => test.meta[TEST_IS_RETRY] === 'true').length
          )
        })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: { ...getCiVisEvpProxyConfig(receiver.port), TESTS_TO_RUN: 'test-early-flake-detection/test' },
          stdio: 'inherit'
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
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests']
        }
      })
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 3
          },
          faulty_session_threshold: 100
        },
        known_tests_enabled: true
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const newTests = tests.filter(test =>
            test.meta[TEST_IS_NEW] === 'true'
          )
          // new tests are detected but not retried
          assert.equal(newTests.length, 1)
          const retriedTests = tests.filter(test =>
            test.meta[TEST_IS_RETRY] === 'true'
          )
          assert.equal(retriedTests.length, 0)
        })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'test/ci-visibility-test',
            DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: 'false'
          },
          stdio: 'inherit'
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('retries flaky tests', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/occasionally-failing-test will be considered new
      receiver.setKnownTests({})

      const NUM_RETRIES_EFD = 5
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD
          },
          faulty_session_threshold: 100
        },
        known_tests_enabled: true
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // all but one has been retried
          assert.equal(
            tests.length - 1,
            retriedTests.length
          )
          assert.equal(retriedTests.length, NUM_RETRIES_EFD)
          // Out of NUM_RETRIES_EFD + 1 total runs, half will be passing and half will be failing,
          // based on the global counter in the test file
          const passingTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
          const failingTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.equal(passingTests.length, (NUM_RETRIES_EFD + 1) / 2)
          assert.equal(failingTests.length, (NUM_RETRIES_EFD + 1) / 2)
          // Test name does not change
          retriedTests.forEach(test => {
            assert.equal(test.meta[TEST_NAME], 'fail occasionally fails')
          })
        })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'test-early-flake-detection/occasionally-failing-test'
          },
          stdio: 'inherit'
        }
      )
      childProcess.on('exit', () => {
        // TODO: check exit code: if a new, retried test fails, the exit code should remain 0
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('does not retry new tests that are skipped', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/skipped-and-todo-test will be considered new
      receiver.setKnownTests({})

      const NUM_RETRIES_EFD = 5
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD
          },
          faulty_session_threshold: 100
        },
        known_tests_enabled: true
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const newSkippedTests = tests.filter(
            test => test.meta[TEST_NAME] === 'ci visibility skip will not be retried'
          )
          assert.equal(newSkippedTests.length, 1)
          assert.notProperty(newSkippedTests[0].meta, TEST_IS_RETRY)

          const newTodoTests = tests.filter(
            test => test.meta[TEST_NAME] === 'ci visibility todo will not be retried'
          )
          assert.equal(newTodoTests.length, 1)
          assert.notProperty(newTodoTests[0].meta, TEST_IS_RETRY)
        })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'test-early-flake-detection/skipped-and-todo-test'
          },
          stdio: 'inherit'
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
            '5s': 3
          },
          faulty_session_threshold: 100
        },
        known_tests_enabled: true
      })
      // Tests from ci-visibility/test/skipped-and-todo-test will be considered new
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test-early-flake-detection/weird-test-names.js': [
            'no describe can do stuff',
            'describe  trailing space '
          ]
        }
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.equal(tests.length, 2)

          const resourceNames = tests.map(test => test.resource)

          assert.includeMembers(resourceNames,
            [
              'ci-visibility/test-early-flake-detection/weird-test-names.js.no describe can do stuff',
              'ci-visibility/test-early-flake-detection/weird-test-names.js.describe  trailing space '
            ]
          )

          const newTests = tests.filter(
            test => test.meta[TEST_IS_NEW] === 'true'
          )
          // no new tests
          assert.equal(newTests.length, 0)
        })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'test-early-flake-detection/weird-test-names'
          },
          stdio: 'inherit'
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
            '5s': NUM_RETRIES_EFD
          },
          faulty_session_threshold: 100
        },
        known_tests_enabled: true
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.equal(tests.length, 2)
          const newTests = tests.filter(
            test => test.meta[TEST_IS_NEW] === 'true'
          )
          assert.equal(newTests.length, 0)
        })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'test/ci-visibility-test'
          },
          stdio: 'inherit'
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => done()).catch(done)
      })
    })

    it('retries flaky tests and sets exit code to 0 as long as one attempt passes', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/occasionally-failing-test will be considered new
      receiver.setKnownTests({})

      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD
          },
          faulty_session_threshold: 100
        },
        known_tests_enabled: true
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // all but one has been retried
          assert.equal(
            tests.length - 1,
            retriedTests.length
          )
          assert.equal(retriedTests.length, NUM_RETRIES_EFD)
          // Out of NUM_RETRIES_EFD + 1 total runs, half will be passing and half will be failing,
          // based on the global counter in the test file
          const passingTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
          const failingTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
          assert.equal(passingTests.length, (NUM_RETRIES_EFD + 1) / 2)
          assert.equal(failingTests.length, (NUM_RETRIES_EFD + 1) / 2)
          // Test name does not change
          retriedTests.forEach(test => {
            assert.equal(test.meta[TEST_NAME], 'fail occasionally fails')
          })
        })

      childProcess = exec(
        'node ./node_modules/jest/bin/jest --config config-jest.js',
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: '**/ci-visibility/test-early-flake-detection/occasionally-failing-test*'
          },
          stdio: 'inherit'
        }
      )

      childProcess.stdout.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr.on('data', (chunk) => {
        testOutput += chunk.toString()
      })

      childProcess.on('exit', (exitCode) => {
        assert.include(testOutput, '2 failed, 2 passed')
        assert.equal(exitCode, 0)
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('does not run early flake detection on snapshot tests', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test-early-flake-detection/jest-snapshot.js will be considered new
      // but we don't retry them because they have snapshots
      receiver.setKnownTests({})

      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD
          },
          faulty_session_threshold: 100
        },
        known_tests_enabled: true
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.equal(tests.length, 1)

          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

          assert.equal(retriedTests.length, 0)

          // we still detect that it's new
          const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
          assert.equal(newTests.length, 1)
        })

      childProcess = exec(runTestsWithCoverageCommand, {
        cwd,
        env: {
          ...getCiVisEvpProxyConfig(receiver.port),
          TESTS_TO_RUN: 'ci-visibility/test-early-flake-detection/jest-snapshot',
          CI: '1' // needs to be run as CI so snapshots are not written
        },
        stdio: 'inherit'
      })

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('bails out of EFD if the percentage of new tests is too high', (done) => {
      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/ci-visibility-test* will be considered new
      receiver.setKnownTests({})

      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD
          },
          faulty_session_threshold: 1
        },
        known_tests_enabled: true
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ABORT_REASON, 'faulty')

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.equal(tests.length, 2)

          const newTests = tests.filter(
            test => test.meta[TEST_IS_NEW] === 'true'
          )
          // no new tests
          assert.equal(newTests.length, 0)
        })

      childProcess = exec(runTestsWithCoverageCommand, {
        cwd,
        env: {
          ...getCiVisEvpProxyConfig(receiver.port),
          TESTS_TO_RUN: 'test/ci-visibility-test'
        },
        stdio: 'inherit'
      })

      childProcess.on('exit', () => {
        eventsPromise.then(() => done()).catch(done)
      })
    })

    it('works with jsdom', (done) => {
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests']
        }
      })
      const NUM_RETRIES_EFD = 3
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': NUM_RETRIES_EFD
          },
          faulty_session_threshold: 100
        },
        known_tests_enabled: true
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
            assert.notProperty(test.meta, TEST_IS_NEW)
          })
          assert.equal(oldTests.length, 1)

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
          )
          newTests.forEach(test => {
            assert.propertyVal(test.meta, TEST_IS_NEW, 'true')
          })
          const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // all but one has been retried
          assert.equal(
            newTests.length - 1,
            retriedTests.length
          )
          assert.equal(retriedTests.length, NUM_RETRIES_EFD)
          // Test name does not change
          newTests.forEach(test => {
            assert.equal(test.meta[TEST_NAME], 'ci visibility 2 can report tests 2')
          })
        })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port), // use agentless for this test, just for variety
            TESTS_TO_RUN: 'test/ci-visibility-test',
            ENABLE_JSDOM: true,
            DD_TRACE_DEBUG: 1,
            DD_TRACE_LOG_LEVEL: 'warn'
          },
          stdio: 'inherit'
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('disables early flake detection if known tests should not be requested', (done) => {
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 3
          }
        },
        known_tests_enabled: false
      })

      receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
      // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
      receiver.setKnownTests({
        jest: {
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests']
        }
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          const oldTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test.js'
          )
          oldTests.forEach(test => {
            assert.notProperty(test.meta, TEST_IS_NEW)
          })
          assert.equal(oldTests.length, 1)
          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
          )
          newTests.forEach(test => {
            assert.notProperty(test.meta, TEST_IS_NEW)
          })
          const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.equal(retriedTests.length, 0)
        })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: { ...getCiVisEvpProxyConfig(receiver.port), TESTS_TO_RUN: 'test/ci-visibility-test' },
          stdio: 'inherit'
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })
  })

  context('flaky test retries', () => {
    it('retries failed tests automatically', (done) => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        flaky_test_retries_enabled: true,
        early_flake_detection: {
          enabled: false
        }
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.equal(tests.length, 10)
          assert.includeMembers(tests.map(test => test.resource), [
            // does not retry
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries will not retry passed tests',
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests',
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests',
            // retries twice and passes
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
            // retries up to 5 times and still fails
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests'
          ])

          const eventuallyPassingTest = tests.filter(
            test => test.resource ===
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests'
          )
          assert.equal(eventuallyPassingTest.length, 3)
          assert.equal(eventuallyPassingTest.filter(test => test.meta[TEST_STATUS] === 'fail').length, 2)
          assert.equal(eventuallyPassingTest.filter(test => test.meta[TEST_STATUS] === 'pass').length, 1)
          assert.equal(eventuallyPassingTest.filter(test => test.meta[TEST_IS_RETRY] === 'true').length, 2)

          const neverPassingTest = tests.filter(
            test => test.resource ===
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests'
          )
          assert.equal(neverPassingTest.length, 6)
          assert.equal(neverPassingTest.filter(test => test.meta[TEST_STATUS] === 'fail').length, 6)
          assert.equal(neverPassingTest.filter(test => test.meta[TEST_STATUS] === 'pass').length, 0)
          assert.equal(neverPassingTest.filter(test => test.meta[TEST_IS_RETRY] === 'true').length, 5)

          const testSuites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)

          const passingSuite = testSuites.find(
            suite => suite.resource === 'test_suite.ci-visibility/jest-flaky/flaky-passes.js'
          )
          assert.equal(passingSuite.meta[TEST_STATUS], 'pass')

          const failedSuite = testSuites.find(
            suite => suite.resource === 'test_suite.ci-visibility/jest-flaky/flaky-fails.js'
          )
          assert.equal(failedSuite.meta[TEST_STATUS], 'fail')
        })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'jest-flaky/flaky-'
          },
          stdio: 'inherit'
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
          enabled: false
        }
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.equal(tests.length, 3)
          assert.includeMembers(tests.map(test => test.resource), [
            // does not retry anything
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries will not retry passed tests',
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests'
          ])

          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

          assert.equal(retriedTests.length, 0)
        })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'jest-flaky/flaky-',
            DD_CIVISIBILITY_FLAKY_RETRY_ENABLED: 'false'
          },
          stdio: 'inherit'
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
          enabled: false
        }
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.equal(tests.length, 5)
          // only one retry
          assert.includeMembers(tests.map(test => test.resource), [
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries will not retry passed tests',
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests',
            'ci-visibility/jest-flaky/flaky-passes.js.test-flaky-test-retries can retry flaky tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests',
            'ci-visibility/jest-flaky/flaky-fails.js.test-flaky-test-retries can retry failed tests'
          ])
        })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            TESTS_TO_RUN: 'jest-flaky/flaky-',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: 1
          },
          stdio: 'inherit'
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => done()).catch(done)
      })
    })
  })

  context('dynamic instrumentation', () => {
    it('does not activate dynamic instrumentation if DD_TEST_DYNAMIC_INSTRUMENTATION_ENABLED is not set', (done) => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true
      })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

          assert.equal(retriedTests.length, 1)
          const [retriedTest] = retriedTests

          const hasDebugTags = Object.keys(retriedTest.meta)
            .some(property => property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED)

          assert.isFalse(hasDebugTags)
        })

      const logsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
          if (payloads.length > 0) {
            throw new Error('Unexpected logs')
          }
        }, 5000)

      childProcess = exec(runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'dynamic-instrumentation/test-hit-breakpoint',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1'
          },
          stdio: 'inherit'
        }
      )

      childProcess.on('exit', (code) => {
        Promise.all([eventsPromise, logsPromise]).then(() => {
          assert.equal(code, 0)
          done()
        }).catch(done)
      })
    })

    it('does not activate dynamic instrumentation if remote settings are disabled', (done) => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: false
      })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

          assert.equal(retriedTests.length, 1)
          const [retriedTest] = retriedTests

          const hasDebugTags = Object.keys(retriedTest.meta)
            .some(property => property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED)

          assert.isFalse(hasDebugTags)
        })
      const logsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
          if (payloads.length > 0) {
            throw new Error('Unexpected logs')
          }
        }, 5000)

      childProcess = exec(runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'dynamic-instrumentation/test-hit-breakpoint',
            DD_TEST_DYNAMIC_INSTRUMENTATION_ENABLED: 'true',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1'
          },
          stdio: 'inherit'
        }
      )

      childProcess.on('exit', (code) => {
        Promise.all([eventsPromise, logsPromise]).then(() => {
          assert.equal(code, 0)
          done()
        }).catch(done)
      })
    })

    it('runs retries with dynamic instrumentation', (done) => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true
      })
      let snapshotIdByTest, snapshotIdByLog
      let spanIdByTest, spanIdByLog, traceIdByTest, traceIdByLog
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

          assert.equal(retriedTests.length, 1)
          const [retriedTest] = retriedTests

          assert.propertyVal(retriedTest.meta, DI_ERROR_DEBUG_INFO_CAPTURED, 'true')

          assert.isTrue(
            retriedTest.meta[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_FILE_SUFFIX}`]
              .endsWith('ci-visibility/dynamic-instrumentation/dependency.js')
          )
          assert.equal(retriedTest.metrics[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_LINE_SUFFIX}`], 4)

          const snapshotIdKey = `${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX}`
          assert.exists(retriedTest.meta[snapshotIdKey])

          snapshotIdByTest = retriedTest.meta[snapshotIdKey]
          spanIdByTest = retriedTest.span_id.toString()
          traceIdByTest = retriedTest.trace_id.toString()

          const notRetriedTest = tests.find(test => test.meta[TEST_NAME].includes('is not retried'))

          assert.notProperty(notRetriedTest.meta, DI_ERROR_DEBUG_INFO_CAPTURED)
        })

      const logsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
          const [{ logMessage: [diLog] }] = payloads
          assert.deepInclude(diLog, {
            ddsource: 'dd_debugger',
            level: 'error'
          })
          assert.equal(diLog.debugger.snapshot.language, 'javascript')
          assert.deepInclude(diLog.debugger.snapshot.captures.lines['4'].locals, {
            a: {
              type: 'number',
              value: '11'
            },
            b: {
              type: 'number',
              value: '3'
            },
            localVariable: {
              type: 'number',
              value: '2'
            }
          })
          spanIdByLog = diLog.dd.span_id
          traceIdByLog = diLog.dd.trace_id
          snapshotIdByLog = diLog.debugger.snapshot.id
        })

      childProcess = exec(runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'dynamic-instrumentation/test-hit-breakpoint',
            DD_TEST_DYNAMIC_INSTRUMENTATION_ENABLED: 'true',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1'
          },
          stdio: 'inherit'
        }
      )

      childProcess.on('exit', () => {
        Promise.all([eventsPromise, logsPromise]).then(() => {
          assert.equal(snapshotIdByTest, snapshotIdByLog)
          assert.equal(spanIdByTest, spanIdByLog)
          assert.equal(traceIdByTest, traceIdByLog)
          done()
        }).catch(done)
      })
    })

    it('does not crash if the retry does not hit the breakpoint', (done) => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true
      })
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

          assert.equal(retriedTests.length, 1)
          const [retriedTest] = retriedTests

          const hasDebugTags = Object.keys(retriedTest.meta)
            .some(property => property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED)

          assert.isFalse(hasDebugTags)
        })
      const logsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
          if (payloads.length > 0) {
            throw new Error('Unexpected logs')
          }
        }, 5000)

      childProcess = exec(runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'dynamic-instrumentation/test-not-hit-breakpoint',
            DD_TEST_DYNAMIC_INSTRUMENTATION_ENABLED: 'true',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1'
          },
          stdio: 'inherit'
        }
      )

      childProcess.on('exit', (code) => {
        Promise.all([eventsPromise, logsPromise]).then(() => {
          assert.equal(code, 0)
          done()
        }).catch(done)
      })
    })

    it('does not wait for breakpoint for a passed test', (done) => {
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        di_enabled: true
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

          assert.equal(retriedTests.length, 1)
          const [retriedTest] = retriedTests
          // Duration is in nanoseconds, so 200 * 1e6 is 200ms
          assert.equal(retriedTest.duration < 200 * 1e6, true)
        })

      childProcess = exec(runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'dynamic-instrumentation/test-hit-breakpoint',
            DD_TEST_DYNAMIC_INSTRUMENTATION_ENABLED: 'true',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            TEST_SHOULD_PASS_AFTER_RETRY: '1'
          },
          stdio: 'inherit'
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
          enabled: false
        }
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.equal(tests.length, 1)
        })

      childProcess = exec(runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'office-addin-mock/test'
          },
          stdio: 'inherit'
        }
      )

      childProcess.on('exit', (code) => {
        eventsPromise.then(() => {
          assert.equal(code, 0)
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
          'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests']
        }
      })
      receiver.setSettings({
        early_flake_detection: {
          enabled: false
        },
        known_tests_enabled: true
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          // no other tests are considered new
          const oldTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test.js'
          )
          oldTests.forEach(test => {
            assert.notProperty(test.meta, TEST_IS_NEW)
          })
          assert.equal(oldTests.length, 1)

          const newTests = tests.filter(test =>
            test.meta[TEST_SUITE] === 'ci-visibility/test/ci-visibility-test-2.js'
          )
          newTests.forEach(test => {
            assert.propertyVal(test.meta, TEST_IS_NEW, 'true')
          })
          const retriedTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          // no test has been retried
          assert.equal(retriedTests.length, 0)
        })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: { ...getCiVisEvpProxyConfig(receiver.port), TESTS_TO_RUN: 'test/ci-visibility-test' },
          stdio: 'inherit'
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })
  })

  it('sets _dd.test.is_user_provided_service to true if DD_SERVICE is used', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)
        tests.forEach(test => {
          assert.equal(test.meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'true')
        })
      })

    childProcess = exec(
      runTestsWithCoverageCommand,
      {
        cwd,
        env: {
          ...getCiVisEvpProxyConfig(receiver.port),
          TESTS_TO_RUN: 'test/ci-visibility-test',
          DD_SERVICE: 'my-service'
        },
        stdio: 'inherit'
      }
    )

    childProcess.on('exit', () => {
      eventsPromise.then(() => {
        done()
      }).catch(done)
    })
  })

  context('quarantine', () => {
    beforeEach(() => {
      receiver.setQuarantinedTests({
        jest: {
          suites: {
            'ci-visibility/quarantine/test-quarantine-1.js': {
              tests: {
                'quarantine tests can quarantine a test': {
                  properties: {
                    quarantined: true
                  }
                }
              }
            }
          }
        }
      })
    })

    const getTestAssertions = (isQuarantining, isParallel) =>
      receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const testSession = events.find(event => event.type === 'test_session_end').content

          if (isQuarantining) {
            assert.propertyVal(testSession.meta, TEST_MANAGEMENT_ENABLED, 'true')
          } else {
            assert.notProperty(testSession.meta, TEST_MANAGEMENT_ENABLED)
          }

          const resourceNames = tests.map(span => span.resource)

          assert.includeMembers(resourceNames,
            [
              'ci-visibility/quarantine/test-quarantine-1.js.quarantine tests can quarantine a test',
              'ci-visibility/quarantine/test-quarantine-1.js.quarantine tests can pass normally'
            ]
          )

          if (isParallel) {
            // Parallel mode in jest requires more than a single test suite
            // Here we check that the second test suite is actually running, so we can be sure that parallel mode is on
            assert.includeMembers(resourceNames, [
              'ci-visibility/quarantine/test-quarantine-2.js.quarantine tests 2 can quarantine a test',
              'ci-visibility/quarantine/test-quarantine-2.js.quarantine tests 2 can pass normally'
            ])
          }

          const failedTest = tests.find(
            test => test.meta[TEST_NAME] === 'quarantine tests can quarantine a test'
          )
          assert.equal(failedTest.meta[TEST_STATUS], 'fail')

          if (isQuarantining) {
            assert.propertyVal(failedTest.meta, TEST_MANAGEMENT_IS_QUARANTINED, 'true')
          } else {
            assert.notProperty(failedTest.meta, TEST_MANAGEMENT_IS_QUARANTINED)
          }
        })

    const runQuarantineTest = (done, isQuarantining, extraEnvVars = {}, isParallel = false) => {
      const testAssertionsPromise = getTestAssertions(isQuarantining, isParallel)

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: 'quarantine/test-quarantine-1',
            SHOULD_CHECK_RESULTS: '1',
            ...extraEnvVars
          },
          stdio: 'inherit'
        }
      )

      childProcess.on('exit', exitCode => {
        testAssertionsPromise.then(() => {
          if (isQuarantining) {
            // even though a test fails, the exit code is 1 because the test is quarantined
            assert.equal(exitCode, 0)
          } else {
            assert.equal(exitCode, 1)
          }
          done()
        }).catch(done)
      })
    }

    it('can quarantine tests', (done) => {
      receiver.setSettings({ test_management: { enabled: true } })

      runQuarantineTest(done, true)
    })

    it('fails if quarantine is not enabled', (done) => {
      receiver.setSettings({ test_management: { enabled: false } })

      runQuarantineTest(done, false)
    })

    it('does not enable quarantine tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
      receiver.setSettings({ test_management: { enabled: true } })

      runQuarantineTest(done, false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
    })

    it('can quarantine in parallel mode', (done) => {
      receiver.setSettings({ test_management: { enabled: true } })

      runQuarantineTest(
        done,
        true,
        {
          // we need to run more than 1 suite for parallel mode to kick in
          TESTS_TO_RUN: 'quarantine/test-quarantine',
          RUN_IN_PARALLEL: true
        },
        true
      )
    })
  })
})
