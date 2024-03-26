'use strict'

const { fork, exec } = require('child_process')
const path = require('path')

const { assert } = require('chai')
const getPort = require('get-port')

const {
  createSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig
} = require('./helpers')
const { FakeCiVisIntake } = require('./ci-visibility-intake')

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
  TEST_EARLY_FLAKE_IS_ENABLED,
  TEST_NAME,
  JEST_DISPLAY_NAME
} = require('../packages/dd-trace/src/plugins/util/test')
const { ERROR_MESSAGE } = require('../packages/dd-trace/src/constants')

const hookFile = 'dd-trace/loader-hook.mjs'

const mochaCommonOptions = {
  name: 'mocha',
  expectedStdout: '2 passing',
  extraStdout: 'end event: can add event listeners to mocha'
}

const jestCommonOptions = {
  name: 'jest',
  dependencies: ['jest', 'chai@v4', 'jest-jasmine2'],
  expectedStdout: 'Test Suites: 2 passed',
  expectedCoverageFiles: [
    'ci-visibility/test/sum.js',
    'ci-visibility/test/ci-visibility-test.js',
    'ci-visibility/test/ci-visibility-test-2.js'
  ]
}

const testFrameworks = [
  {
    ...mochaCommonOptions,
    testFile: 'ci-visibility/run-mocha.js',
    dependencies: ['mocha', 'chai@v4', 'nyc', 'mocha-each'],
    expectedCoverageFiles: [
      'ci-visibility/run-mocha.js',
      'ci-visibility/test/sum.js',
      'ci-visibility/test/ci-visibility-test.js',
      'ci-visibility/test/ci-visibility-test-2.js'
    ],
    runTestsWithCoverageCommand: './node_modules/nyc/bin/nyc.js -r=text-summary node ./ci-visibility/run-mocha.js',
    type: 'commonJS'
  },
  {
    ...jestCommonOptions,
    testFile: 'ci-visibility/run-jest.js',
    runTestsWithCoverageCommand: 'node ./ci-visibility/run-jest.js',
    type: 'commonJS'
  }
]

// TODO: add ESM tests
testFrameworks.forEach(({
  name,
  dependencies,
  testFile,
  expectedStdout,
  extraStdout,
  expectedCoverageFiles,
  runTestsWithCoverageCommand,
  type
}) => {
  describe(`${name} ${type}`, () => {
    let receiver
    let childProcess
    let sandbox
    let cwd
    let startupTestFile
    let testOutput = ''

    before(async function () {
      // add an explicit timeout to make esm tests less flaky
      this.timeout(50000)
      sandbox = await createSandbox(dependencies, true)
      cwd = sandbox.folder
      startupTestFile = path.join(cwd, testFile)
    })

    after(async function () {
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

    if (name === 'mocha') {
      it('does not change mocha config if CI Visibility fails to init', (done) => {
        receiver.assertPayloadReceived(() => {
          const error = new Error('it should not report tests')
          done(error)
        }, ({ url }) => url === '/api/v2/citestcycle', 3000).catch(() => {})

        const { DD_CIVISIBILITY_AGENTLESS_URL, ...restEnvVars } = getCiVisAgentlessConfig(receiver.port)

        // `runMocha` is only executed when using the CLI, which is where we modify mocha config
        // if CI Visibility is init
        childProcess = exec('mocha ./ci-visibility/test/ci-visibility-test.js', {
          cwd,
          env: {
            ...restEnvVars,
            DD_TRACE_DEBUG: 1,
            DD_TRACE_LOG_LEVEL: 'error',
            DD_SITE: '= invalid = url'
          },
          stdio: 'pipe'
        })
        childProcess.stdout.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.on('exit', () => {
          assert.include(testOutput, 'Invalid URL')
          assert.include(testOutput, '1 passing') // we only run one file here
          done()
        })
      }).timeout(50000)

      it('does not init CI Visibility when running in parallel mode', (done) => {
        receiver.assertPayloadReceived(() => {
          const error = new Error('it should not report tests')
          done(error)
        }, ({ url }) => url === '/api/v2/citestcycle', 3000).catch(() => {})

        childProcess = fork(testFile, {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            RUN_IN_PARALLEL: true,
            DD_TRACE_DEBUG: 1,
            DD_TRACE_LOG_LEVEL: 'warn'
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
          assert.include(testOutput, 'Unable to initialize CI Visibility because Mocha is running in parallel mode.')
          done()
        })
      })
    }

    if (name === 'jest') {
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
      describe('when jest is using workers to run tests in parallel', () => {
        it('reports tests when using the agent', (done) => {
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
              RUN_IN_PARALLEL: true
            },
            stdio: 'pipe'
          })

          receiver.gatherPayloads(({ url }) => url === '/api/v2/citestcycle', 5000).then(eventsRequests => {
            const eventTypes = eventsRequests.map(({ payload }) => payload)
              .flatMap(({ events }) => events)
              .map(event => event.type)

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
      it('intelligent test runner can skip when using a custom test sequencer', (done) => {
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
    }
    const reportingOptions = ['agentless', 'evp proxy']

    reportingOptions.forEach(reportingOption => {
      context(`early flake detection when reporting by ${reportingOption}`, () => {
        it('retries new tests', (done) => {
          const envVars = reportingOption === 'agentless'
            ? getCiVisAgentlessConfig(receiver.port)
            : getCiVisEvpProxyConfig(receiver.port)
          if (reportingOption === 'evp proxy') {
            receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
          }
          // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
          receiver.setKnownTests({
            [name]: {
              'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests']
            }
          })
          const NUM_RETRIES_EFD = 3
          receiver.setSettings({
            itr_enabled: false,
            code_coverage: false,
            tests_skipping: false,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD
              }
            }
          })
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              // TODO: maybe check in stdout for the "Retried by Datadog"
              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_IS_ENABLED, 'true')

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

          let TESTS_TO_RUN = 'test/ci-visibility-test'
          if (name === 'mocha') {
            TESTS_TO_RUN = JSON.stringify([
              './test/ci-visibility-test.js',
              './test/ci-visibility-test-2.js'
            ])
          }

          childProcess = exec(
            runTestsWithCoverageCommand,
            {
              cwd,
              env: { ...envVars, TESTS_TO_RUN },
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
          const envVars = reportingOption === 'agentless'
            ? getCiVisAgentlessConfig(receiver.port)
            : getCiVisEvpProxyConfig(receiver.port)
          if (reportingOption === 'evp proxy') {
            receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
          }
          // Tests from ci-visibility/test-early-flake-detection/test-parameterized.js will be considered new
          receiver.setKnownTests({
            [name]: {
              'ci-visibility/test-early-flake-detection/test.js': ['ci visibility can report tests']
            }
          })
          receiver.setSettings({
            itr_enabled: false,
            code_coverage: false,
            tests_skipping: false,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': 3
              }
            }
          })

          const parameterizedTestFile = name === 'mocha' ? 'mocha-parameterized.js' : 'test-parameterized.js'

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_IS_ENABLED, 'true')

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

          let TESTS_TO_RUN = 'test-early-flake-detection/test'
          if (name === 'mocha') {
            TESTS_TO_RUN = JSON.stringify([
              './test-early-flake-detection/test.js',
              `./test-early-flake-detection/${parameterizedTestFile}`
            ])
          }

          childProcess = exec(
            runTestsWithCoverageCommand,
            {
              cwd,
              env: { ...envVars, TESTS_TO_RUN },
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
          const envVars = reportingOption === 'agentless'
            ? getCiVisAgentlessConfig(receiver.port)
            : getCiVisEvpProxyConfig(receiver.port)
          if (reportingOption === 'evp proxy') {
            receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
          }
          // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
          receiver.setKnownTests({
            [name]: {
              'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests']
            }
          })
          receiver.setSettings({
            itr_enabled: false,
            code_coverage: false,
            tests_skipping: false,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': 3
              }
            }
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_IS_ENABLED)

              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const newTests = tests.filter(test =>
                test.meta[TEST_IS_NEW] === 'true'
              )
              // new tests are not detected
              assert.equal(newTests.length, 0)
            })

          let TESTS_TO_RUN = 'test/ci-visibility-test'
          if (name === 'mocha') {
            TESTS_TO_RUN = JSON.stringify([
              './test/ci-visibility-test.js',
              './test/ci-visibility-test-2.js'
            ])
          }

          childProcess = exec(
            runTestsWithCoverageCommand,
            {
              cwd,
              env: {
                ...envVars,
                TESTS_TO_RUN,
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
          const envVars = reportingOption === 'agentless'
            ? getCiVisAgentlessConfig(receiver.port)
            : getCiVisEvpProxyConfig(receiver.port)
          if (reportingOption === 'evp proxy') {
            receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
          }
          // Tests from ci-visibility/test/occasionally-failing-test will be considered new
          receiver.setKnownTests({})

          const NUM_RETRIES_EFD = 5
          receiver.setSettings({
            itr_enabled: false,
            code_coverage: false,
            tests_skipping: false,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD
              }
            }
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_IS_ENABLED, 'true')

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

          let TESTS_TO_RUN = 'test-early-flake-detection/occasionally-failing-test'
          if (name === 'mocha') {
            TESTS_TO_RUN = JSON.stringify([
              './test-early-flake-detection/occasionally-failing-test.js'
            ])
          }

          childProcess = exec(
            runTestsWithCoverageCommand,
            {
              cwd,
              env: { ...envVars, TESTS_TO_RUN },
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
          const envVars = reportingOption === 'agentless'
            ? getCiVisAgentlessConfig(receiver.port)
            : getCiVisEvpProxyConfig(receiver.port)
          if (reportingOption === 'evp proxy') {
            receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
          }
          // Tests from ci-visibility/test/skipped-and-todo-test will be considered new
          receiver.setKnownTests({})

          const NUM_RETRIES_EFD = 5
          receiver.setSettings({
            itr_enabled: false,
            code_coverage: false,
            tests_skipping: false,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD
              }
            }
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_IS_ENABLED, 'true')

              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              const newSkippedTests = tests.filter(
                test => test.meta[TEST_NAME] === 'ci visibility skip will not be retried'
              )
              assert.equal(newSkippedTests.length, 1)
              assert.notProperty(newSkippedTests[0].meta, TEST_IS_RETRY)

              if (name === 'jest') {
                const newTodoTests = tests.filter(
                  test => test.meta[TEST_NAME] === 'ci visibility todo will not be retried'
                )
                assert.equal(newTodoTests.length, 1)
                assert.notProperty(newTodoTests[0].meta, TEST_IS_RETRY)
              }
            })

          let TESTS_TO_RUN = 'test-early-flake-detection/skipped-and-todo-test'
          if (name === 'mocha') {
            TESTS_TO_RUN = JSON.stringify([
              './test-early-flake-detection/skipped-and-todo-test.js'
            ])
          }

          childProcess = exec(
            runTestsWithCoverageCommand,
            {
              cwd,
              env: { ...envVars, TESTS_TO_RUN },
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
          const envVars = reportingOption === 'agentless'
            ? getCiVisAgentlessConfig(receiver.port)
            : getCiVisEvpProxyConfig(receiver.port)
          if (reportingOption === 'evp proxy') {
            receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
          }
          // Tests from ci-visibility/test/skipped-and-todo-test will be considered new
          receiver.setKnownTests({
            [name]: {
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

          let TESTS_TO_RUN = 'test-early-flake-detection/weird-test-names'
          if (name === 'mocha') {
            TESTS_TO_RUN = JSON.stringify([
              './test-early-flake-detection/weird-test-names.js'
            ])
          }

          childProcess = exec(
            runTestsWithCoverageCommand,
            {
              cwd,
              env: {
                ...envVars,
                TESTS_TO_RUN
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
          const envVars = reportingOption === 'agentless'
            ? getCiVisAgentlessConfig(receiver.port)
            : getCiVisEvpProxyConfig(receiver.port)
          if (reportingOption === 'evp proxy') {
            receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
          }
          receiver.setKnownTestsResponseCode(500)

          const NUM_RETRIES_EFD = 5
          receiver.setSettings({
            itr_enabled: false,
            code_coverage: false,
            tests_skipping: false,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD
              }
            }
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_IS_ENABLED)

              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              assert.equal(tests.length, 2)
              const newTests = tests.filter(
                test => test.meta[TEST_IS_NEW] === 'true'
              )
              assert.equal(newTests.length, 0)
            })

          let TESTS_TO_RUN = 'test/ci-visibility-test'
          if (name === 'mocha') {
            TESTS_TO_RUN = JSON.stringify([
              './test/ci-visibility-test.js',
              './test/ci-visibility-test-2.js'
            ])
          }

          childProcess = exec(
            runTestsWithCoverageCommand,
            {
              cwd,
              env: {
                ...envVars,
                TESTS_TO_RUN
              },
              stdio: 'inherit'
            }
          )

          childProcess.on('exit', () => {
            eventsPromise.then(() => done()).catch(done)
          })
        })
        it('retries flaky tests and sets exit code to 0 as long as one attempt passes', (done) => {
          const envVars = reportingOption === 'agentless'
            ? getCiVisAgentlessConfig(receiver.port)
            : getCiVisEvpProxyConfig(receiver.port)
          if (reportingOption === 'evp proxy') {
            receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
          }
          // Tests from ci-visibility/test/ci-visibility-test-2.js will be considered new
          receiver.setKnownTests({
            [name]: {
              'ci-visibility/test/ci-visibility-test.js': ['ci visibility can report tests']
            }
          })
          const NUM_RETRIES_EFD = 3
          receiver.setSettings({
            itr_enabled: false,
            code_coverage: false,
            tests_skipping: false,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD
              }
            }
          })

          const command = name === 'jest'
            ? 'node ./node_modules/jest/bin/jest --config config-jest.js'
            : 'node ./node_modules/mocha/bin/mocha ci-visibility/test-early-flake-detection/occasionally-failing-test*'

          childProcess = exec(
            command,
            {
              cwd,
              env: {
                ...envVars,
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
            if (name === 'jest') {
              assert.include(testOutput, '2 failed, 2 passed')
            } else {
              assert.include(testOutput, '2 passing')
              assert.include(testOutput, '2 failing')
            }
            assert.equal(exitCode, 0)
            done()
          })
        })
      })
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

        if (extraStdout) {
          assert.include(testOutput, extraStdout)
        }
        // Can read DD_TAGS
        testSpans.forEach(testSpan => {
          assert.propertyVal(testSpan.meta, 'test.customtag', 'customvalue')
          assert.propertyVal(testSpan.meta, 'test.customtag2', 'customvalue2')
        })

        testSpans.forEach(testSpan => {
          assert.equal(testSpan.meta[TEST_SOURCE_FILE].startsWith('ci-visibility/test/ci-visibility-test'), true)
        })

        done()
      })

      childProcess = fork(startupTestFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: receiver.port,
          NODE_OPTIONS: type === 'esm' ? `-r dd-trace/ci/init --loader=${hookFile}` : '-r dd-trace/ci/init',
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

    describe('agentless', () => {
      it('reports errors in test sessions', (done) => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.propertyVal(testSession.meta, TEST_STATUS, 'fail')
            const errorMessage = name === 'mocha' ? 'Failed tests: 1' : 'Failed test suites: 1. Failed tests: 1'
            assert.include(testSession.meta[ERROR_MESSAGE], errorMessage)
          })

        let TESTS_TO_RUN = 'test/fail-test'
        if (name === 'mocha') {
          TESTS_TO_RUN = JSON.stringify([
            './test/fail-test.js'
          ])
        }

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN
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
      it('can report code coverage', (done) => {
        let testOutput
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
          // coverage report
          if (name === 'mocha') {
            assert.include(testOutput, 'Lines        ')
          }
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

        let TESTS_TO_RUN = 'unskippable-test/test-'
        if (name === 'mocha') {
          TESTS_TO_RUN = JSON.stringify([
            './unskippable-test/test-to-run.js',
            './unskippable-test/test-to-skip.js',
            './unskippable-test/test-unskippable.js'
          ])
        }

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN
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

        let TESTS_TO_RUN = 'unskippable-test/test-'
        if (name === 'mocha') {
          TESTS_TO_RUN = JSON.stringify([
            './unskippable-test/test-to-run.js',
            './unskippable-test/test-to-skip.js',
            './unskippable-test/test-unskippable.js'
          ])
        }

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TESTS_TO_RUN
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
    })

    describe('evp proxy', () => {
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
      it('reports errors in test sessions', (done) => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.propertyVal(testSession.meta, TEST_STATUS, 'fail')
            const errorMessage = name === 'mocha' ? 'Failed tests: 1' : 'Failed test suites: 1. Failed tests: 1'
            assert.include(testSession.meta[ERROR_MESSAGE], errorMessage)
          })

        let TESTS_TO_RUN = 'test/fail-test'
        if (name === 'mocha') {
          TESTS_TO_RUN = JSON.stringify([
            './test/fail-test.js'
          ])
        }

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: {
              ...getCiVisEvpProxyConfig(receiver.port),
              TESTS_TO_RUN
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
          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
          const numSuites = eventTypes.reduce(
            (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
          )
          assert.equal(numSuites, 2)
          done()
        }).catch(done)

        childProcess = fork(startupTestFile, {
          cwd,
          env: getCiVisEvpProxyConfig(receiver.port),
          stdio: 'pipe'
        })
      })
      it('can report code coverage', (done) => {
        let testOutput
        const libraryConfigRequestPromise = receiver.payloadReceived(
          ({ url }) => url === '/evp_proxy/v2/api/v2/libraries/tests/services/setting'
        )
        const codeCovRequestPromise = receiver.payloadReceived(({ url }) => url === '/evp_proxy/v2/api/v2/citestcov')
        const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/evp_proxy/v2/api/v2/citestcycle')

        Promise.all([
          libraryConfigRequestPromise,
          codeCovRequestPromise,
          eventsRequestPromise
        ]).then(([libraryConfigRequest, codeCovRequest, eventsRequest]) => {
          assert.notProperty(libraryConfigRequest.headers, 'dd-api-key')
          assert.propertyVal(libraryConfigRequest.headers, 'x-datadog-evp-subdomain', 'api')

          const [coveragePayload] = codeCovRequest.payload
          assert.notProperty(codeCovRequest.headers, 'dd-api-key')

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
            env: getCiVisEvpProxyConfig(receiver.port),
            stdio: 'pipe'
          }
        )
        childProcess.stdout.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.on('exit', () => {
          // coverage report
          if (name === 'mocha') {
            assert.include(testOutput, 'Lines        ')
          }
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
        }, ({ url }) => url === '/evp_proxy/v2/api/v2/citestcov').catch(() => {})

        receiver.assertPayloadReceived(({ headers, payload }) => {
          assert.notProperty(headers, 'dd-api-key')
          assert.propertyVal(headers, 'x-datadog-evp-subdomain', 'citestcycle-intake')
          const eventTypes = payload.events.map(event => event.type)
          assert.includeMembers(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
          const testSession = payload.events.find(event => event.type === 'test_session_end').content
          assert.exists(testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT])
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
          assert.propertyVal(skippableRequest.headers, 'x-datadog-evp-subdomain', 'api')

          const [coveragePayload] = coverageRequest.payload
          assert.notProperty(coverageRequest.headers, 'dd-api-key')
          assert.propertyVal(coverageRequest.headers, 'x-datadog-evp-subdomain', 'citestcov-intake')
          assert.propertyVal(coveragePayload, 'name', 'coverage1')
          assert.propertyVal(coveragePayload, 'filename', 'coverage1.msgpack')
          assert.propertyVal(coveragePayload, 'type', 'application/msgpack')

          assert.notProperty(eventsRequest.headers, 'dd-api-key')
          assert.propertyVal(eventsRequest.headers, 'x-datadog-evp-subdomain', 'citestcycle-intake')
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
            env: getCiVisEvpProxyConfig(receiver.port),
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
        receiver.assertPayloadReceived(() => {
          const error = new Error('should not request skippable')
          done(error)
        }, ({ url }) => url === '/evp_proxy/v2/api/v2/ci/tests/skippable').catch(() => {})

        receiver.assertPayloadReceived(({ headers, payload }) => {
          assert.notProperty(headers, 'dd-api-key')
          assert.propertyVal(headers, 'x-datadog-evp-subdomain', 'citestcycle-intake')
          const eventTypes = payload.events.map(event => event.type)
          // because they are not skipped
          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
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
        }, ({ url }) => url === '/evp_proxy/v2/api/v2/ci/tests/skippable').catch(() => {})

        receiver.assertPayloadReceived(({ headers, payload }) => {
          assert.notProperty(headers, 'dd-api-key')
          assert.propertyVal(headers, 'x-datadog-evp-subdomain', 'citestcycle-intake')
          const eventTypes = payload.events.map(event => event.type)
          // because they are not skipped
          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_module_end', 'test_session_end'])
          const numSuites = eventTypes.reduce(
            (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
          )
          assert.equal(numSuites, 2)
        }, ({ url }) => url === '/evp_proxy/v2/api/v2/citestcycle').then(() => done()).catch(done)

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

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: getCiVisEvpProxyConfig(receiver.port),
            stdio: 'inherit'
          }
        )
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
            env: getCiVisEvpProxyConfig(receiver.port),
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
            env: getCiVisEvpProxyConfig(receiver.port),
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
  })
})
