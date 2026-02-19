'use strict'

const assert = require('node:assert/strict')

const { once } = require('node:events')
const { exec, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const { assertObjectContains } = require('../helpers')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  TEST_STATUS,
  TEST_TYPE,
  TEST_IS_RETRY,
  TEST_CODE_OWNERS,
  TEST_CODE_COVERAGE_LINES_PCT,
  TEST_SESSION_NAME,
  TEST_COMMAND,
  TEST_LEVEL_EVENT_TYPES,
  TEST_SOURCE_FILE,
  TEST_SOURCE_START,
  TEST_IS_NEW,
  TEST_NAME,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_SUITE,
  DI_ERROR_DEBUG_INFO_CAPTURED,
  DI_DEBUG_ERROR_PREFIX,
  DI_DEBUG_ERROR_FILE_SUFFIX,
  DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX,
  DI_DEBUG_ERROR_LINE_SUFFIX,
  TEST_RETRY_REASON,
  DD_TEST_IS_USER_PROVIDED_SERVICE,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  DD_CAPABILITIES_TEST_IMPACT_ANALYSIS,
  DD_CAPABILITIES_EARLY_FLAKE_DETECTION,
  DD_CAPABILITIES_AUTO_TEST_RETRIES,
  DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE,
  DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE,
  DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX,
  DD_CAPABILITIES_FAILED_TEST_REPLAY,
  TEST_RETRY_REASON_TYPES,
  TEST_IS_MODIFIED,
  DD_CAPABILITIES_IMPACTED_TESTS,
  VITEST_POOL,
  TEST_IS_TEST_FRAMEWORK_WORKER,
  GIT_COMMIT_SHA,
  GIT_REPOSITORY_URL,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')
const { TELEMETRY_COVERAGE_UPLOAD } = require('../../packages/dd-trace/src/ci-visibility/telemetry')
const { NODE_MAJOR } = require('../../version')

const NUM_RETRIES_EFD = 3

const versions = ['1.6.0', 'latest']

const linePctMatchRegex = /Lines\s+:\s+([\d.]+)%/

versions.forEach((version) => {
  describe(`vitest@${version}`, () => {
    let cwd, receiver, childProcess, testOutput

    useSandbox([
      `vitest@${version}`,
      `@vitest/coverage-istanbul@${version}`,
      `@vitest/coverage-v8@${version}`,
      'tinypool',
    ], true)

    before(function () {
      cwd = sandboxCwd()
    })

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async () => {
      testOutput = ''
      childProcess.kill()
      await receiver.stop()
    })

    const poolConfig = ['forks', 'threads']

    poolConfig.forEach((poolConfig) => {
      it(`can run and report tests with pool=${poolConfig}`, async () => {
        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more flags
              DD_TEST_SESSION_NAME: 'my-test-session',
              POOL_CONFIG: poolConfig,
              DD_SERVICE: undefined,
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

            metadataDicts.forEach(metadata => {
              for (const testLevel of TEST_LEVEL_EVENT_TYPES) {
                assert.strictEqual(metadata[testLevel][TEST_SESSION_NAME], 'my-test-session')
              }
            })

            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSessionEvent = events.find(event => event.type === 'test_session_end')

            if (poolConfig === 'threads') {
              assert.strictEqual(testSessionEvent.content.meta[VITEST_POOL], 'worker_threads')
            } else {
              assert.strictEqual(testSessionEvent.content.meta[VITEST_POOL], 'child_process')
            }

            const testModuleEvent = events.find(event => event.type === 'test_module_end')
            const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
            const testEvents = events.filter(event => event.type === 'test')

            assert.ok(testSessionEvent.content.resource.includes('test_session.vitest run'))
            assert.strictEqual(testSessionEvent.content.meta[TEST_STATUS], 'fail')
            assert.ok(testModuleEvent.content.resource.includes('test_module.vitest run'))
            assert.strictEqual(testModuleEvent.content.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testSessionEvent.content.meta[TEST_TYPE], 'test')
            assert.strictEqual(testModuleEvent.content.meta[TEST_TYPE], 'test')

            const passedSuite = testSuiteEvents.find(
              suite =>
                suite.content.resource === 'test_suite.ci-visibility/vitest-tests/test-visibility-passed-suite.mjs'
            )
            assert.strictEqual(passedSuite.content.meta[TEST_STATUS], 'pass')

            const failedSuite = testSuiteEvents.find(
              suite =>
                suite.content.resource === 'test_suite.ci-visibility/vitest-tests/test-visibility-failed-suite.mjs'
            )
            assert.strictEqual(failedSuite.content.meta[TEST_STATUS], 'fail')

            const failedSuiteHooks = testSuiteEvents.find(
              suite =>
                suite.content.resource === 'test_suite.ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs'
            )
            assert.strictEqual(failedSuiteHooks.content.meta[TEST_STATUS], 'fail')

            assert.deepStrictEqual(testEvents.map(test => test.content.resource).sort(),
              [
                'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.context can report failed test',
                'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.context can report more',
                'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.other context can report more',
                'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.other context can report passed test',
                'ci-visibility/vitest-tests/test-visibility-failed-suite.mjs' +
                '.test-visibility-failed-suite-first-describe can report failed test',
                'ci-visibility/vitest-tests/test-visibility-failed-suite.mjs' +
                '.test-visibility-failed-suite-first-describe can report more',
                'ci-visibility/vitest-tests/test-visibility-failed-suite.mjs' +
                '.test-visibility-failed-suite-second-describe can report more',
                'ci-visibility/vitest-tests/test-visibility-failed-suite.mjs' +
                '.test-visibility-failed-suite-second-describe can report passed test',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.context can report more',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.context can report passed test',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.no suite',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can programmatic skip',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can report more',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can report passed test',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can skip',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can todo',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.programmatic skip no suite',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.skip no suite',
              ]
            )

            const failedTests = testEvents.filter(test => test.content.meta[TEST_STATUS] === 'fail')

            assertObjectContains(
              failedTests.map(test => test.content.resource).sort(),
              [
                'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.context can report failed test',
                'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.context can report more',
                'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.other context can report more',
                'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.other context can report passed test',
                'ci-visibility/vitest-tests/test-visibility-failed-suite.mjs' +
                '.test-visibility-failed-suite-first-describe can report failed test',
              ]
            )

            const skippedTests = testEvents.filter(test => test.content.meta[TEST_STATUS] === 'skip')

            assertObjectContains(
              skippedTests.map(test => test.content.resource),
              [
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can skip',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can todo',
                'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can programmatic skip',
              ]
            )

            testEvents.forEach(test => {
              // `threads` config will report directly. TODO: update this once we're testing vitest@>=4
              if (poolConfig === 'forks') {
                assert.strictEqual(test.content.meta[TEST_IS_TEST_FRAMEWORK_WORKER], 'true')
              }
              assert.strictEqual(test.content.meta[TEST_COMMAND], 'vitest run')
              assert.ok(test.content.metrics[DD_HOST_CPU_COUNT])
              assert.strictEqual(test.content.meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'false')
            })

            testSuiteEvents.forEach(testSuite => {
              // `threads` config will report directly. TODO: update this once we're testing vitest@>=4
              if (poolConfig === 'forks') {
                assert.strictEqual(testSuite.content.meta[TEST_IS_TEST_FRAMEWORK_WORKER], 'true')
              }
              assert.strictEqual(testSuite.content.meta[TEST_COMMAND], 'vitest run')
              assert.strictEqual(
                testSuite.content.meta[TEST_SOURCE_FILE].startsWith('ci-visibility/vitest-tests/test-visibility'),
                true
              )
              assert.strictEqual(testSuite.content.metrics[TEST_SOURCE_START], 1)
              assert.ok(testSuite.content.metrics[DD_HOST_CPU_COUNT])
            })
          }),
        ])
      })
    })

    it('sends telemetry with test_session metric when telemetry is enabled', async () => {
      const telemetryPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/apmtelemetry'), (payloads) => {
          const telemetryMetrics = payloads.flatMap(({ payload }) => payload.payload.series)

          const testSessionMetric = telemetryMetrics.find(
            ({ metric }) => metric === 'test_session'
          )

          assert.ok(testSessionMetric, 'test_session telemetry metric should be sent')
        })

      childProcess = exec(
        './node_modules/.bin/vitest run',
        {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            DD_TRACE_AGENT_PORT: String(receiver.port),
            DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'true',
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more flags
            TEST_DIR: 'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        telemetryPromise,
      ])
    })

    context('flaky test retries', () => {
      it('can retry flaky tests', (done) => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: {
            enabled: false,
          },
        })

        receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testEvents = events.filter(event => event.type === 'test')
          assert.strictEqual(testEvents.length, 11)
          assertObjectContains(testEvents.map(test => test.content.resource), [
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            // passes at the third retry
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            // never passes
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            // passes on the first try
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries does not retry if unnecessary',
          ])
          const eventuallyPassingTest = testEvents.filter(
            test => test.content.resource ===
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass'
          )
          assert.strictEqual(eventuallyPassingTest.length, 4)
          assert.strictEqual(eventuallyPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'fail').length, 3)
          assert.strictEqual(eventuallyPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'pass').length, 1)
          assert.strictEqual(
            eventuallyPassingTest.filter(test => test.content.meta[TEST_IS_RETRY] === 'true').length,
            3
          )
          assert.strictEqual(eventuallyPassingTest.filter(test =>
            test.content.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          ).length, 3)

          const neverPassingTest = testEvents.filter(
            test => test.content.resource ===
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass'
          )
          assert.strictEqual(neverPassingTest.length, 6)
          assert.strictEqual(neverPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'fail').length, 6)
          assert.strictEqual(neverPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'pass').length, 0)
          assert.strictEqual(neverPassingTest.filter(test => test.content.meta[TEST_IS_RETRY] === 'true').length, 5)
          assert.strictEqual(neverPassingTest.filter(test =>
            test.content.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          ).length, 5)
        }).then(() => done()).catch(done)

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/flaky-test-retries*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more flags
            },
          }
        )
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

        receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testEvents = events.filter(event => event.type === 'test')
          assert.strictEqual(testEvents.length, 3)
          assertObjectContains(testEvents.map(test => test.content.resource), [
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries does not retry if unnecessary',
          ])
          assert.strictEqual(testEvents.filter(
            test => test.content.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          ).length, 0)
        }).then(() => done()).catch(done)

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/flaky-test-retries*',
              DD_CIVISIBILITY_FLAKY_RETRY_ENABLED: 'false',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more flags
            },
          }
        )
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

        receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testEvents = events.filter(event => event.type === 'test')
          assert.strictEqual(testEvents.length, 5)
          assertObjectContains(testEvents.map(test => test.content.resource), [
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries does not retry if unnecessary',
          ])
          assert.strictEqual(testEvents.filter(
            test => test.content.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          ).length, 2)
        }).then(() => done()).catch(done)

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/flaky-test-retries*',
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more flags
            },
          }
        )
      })
    })

    it('correctly calculates test code owners when working directory is not repository root', (done) => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const test = events.find(event => event.type === 'test').content
          const testSuite = events.find(event => event.type === 'test_suite_end').content
          assert.strictEqual(test.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
          assert.strictEqual(testSuite.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
        }, 25000)

      childProcess = exec(
        '../../node_modules/.bin/vitest run',
        {
          cwd: `${cwd}/ci-visibility/subproject`,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            TEST_DIR: './vitest-test.mjs',
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    // total code coverage only works for >=2.0.0
    // v4 dropped support for Node 18. Every test but this once passes, so we'll leave them
    // for now. The breaking change is in https://github.com/vitest-dev/vitest/commit/9a0bf2254
    // shipped in https://github.com/vitest-dev/vitest/releases/tag/v4.0.0-beta.12
    if (version === 'latest' && NODE_MAJOR >= 20) {
      const coverageProviders = ['v8', 'istanbul']

      coverageProviders.forEach((coverageProvider) => {
        it(`reports code coverage for ${coverageProvider} provider`, async () => {
          let codeCoverageExtracted
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSession = events.find(event => event.type === 'test_session_end').content

              codeCoverageExtracted = testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT]
            })

          childProcess = exec(
            './node_modules/.bin/vitest run --coverage',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
                COVERAGE_PROVIDER: coverageProvider,
                TEST_DIR: 'ci-visibility/vitest-tests/coverage-test.mjs',
              },
            }
          )

          childProcess.stdout?.on('data', (chunk) => {
            testOutput += chunk.toString()
          })
          childProcess.stderr?.on('data', (chunk) => {
            testOutput += chunk.toString()
          })

          await Promise.all([
            once(childProcess, 'exit'),
            eventsPromise,
          ])

          const linePctMatch = testOutput.match(linePctMatchRegex)
          const linesPctFromNyc = Number(linePctMatch[1])

          assert.strictEqual(
            linesPctFromNyc,
            codeCoverageExtracted,
            'coverage reported by vitest does not match extracted coverage'
          )
        })
      })

      it('reports zero code coverage for instanbul provider', async () => {
        let codeCoverageExtracted
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content

            codeCoverageExtracted = testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT]
          })

        childProcess = exec(
          './node_modules/.bin/vitest run --coverage',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              COVERAGE_PROVIDER: 'istanbul',
              TEST_DIR: 'ci-visibility/vitest-tests/coverage-test-zero.mjs',
            },
          }
        )

        childProcess.stdout?.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr?.on('data', (chunk) => {
          testOutput += chunk.toString()
        })

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])

        const linePctMatch = testOutput.match(linePctMatchRegex)
        const linesPctFromNyc = Number(linePctMatch[1])

        assert.strictEqual(
          linesPctFromNyc,
          codeCoverageExtracted,
          'coverage reported by vitest does not match extracted coverage'
        )
        assert.strictEqual(
          linesPctFromNyc,
          0,
          'zero coverage should be reported'
        )
      })
    }

    context('early flake detection', () => {
      it('retries new tests', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection can retry tests that eventually fail', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // skipped so not retried
              'early flake detection does not retry if it is not new',
            ],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.strictEqual(tests.length, 14)

            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that eventually fail',
              'early flake detection can retry tests that eventually fail',
              'early flake detection can retry tests that eventually fail',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped',
              'early flake detection can retry tests that eventually fail',
            ])
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            // 4 executions of the 3 new tests + 1 new skipped test (not retried)
            assert.strictEqual(newTests.length, 13)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 9) // 3 retries of the 3 new tests

            retriedTests.forEach(test => {
              assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
            })

            // exit code should be 0 and test session should be reported as passed,
            // even though there are some failing executions
            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 3)
            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'pass')
            assert.strictEqual(testSessionEvent.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              SHOULD_ADD_EVENTUALLY_FAIL: '1',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 0)
            done()
          }).catch(done)
        })
      })

      it('fails if all the attempts fail', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // skipped so not retried
              'early flake detection does not retry if it is not new',
            ],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.strictEqual(tests.length, 10)

            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped',
            ])
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            // 4 executions of the 2 new tests + 1 new skipped test (not retried)
            assert.strictEqual(newTests.length, 9)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 6) // 3 retries of the 2 new tests

            // the multiple attempts did not result in a single pass,
            // so the test session should be reported as failed
            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 6)
            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testSessionEvent.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

            // Check that TEST_HAS_FAILED_ALL_RETRIES is set for tests that fail all EFD attempts
            const alwaysFailTests = tests.filter(test =>
              test.meta[TEST_NAME] === 'early flake detection can retry tests that always pass'
            )
            assert.strictEqual(alwaysFailTests.length, 4) // 1 initial + 3 retries
            // The last execution should have TEST_HAS_FAILED_ALL_RETRIES set
            const testsWithFlag = alwaysFailTests.filter(test =>
              test.meta[TEST_HAS_FAILED_ALL_RETRIES] === 'true'
            )
            assert.strictEqual(
              testsWithFlag.length,
              1,
              'Exactly one test should have TEST_HAS_FAILED_ALL_RETRIES set'
            )
            // It should be the last one
            const lastAttempt = alwaysFailTests[alwaysFailTests.length - 1]
            assert.strictEqual(
              lastAttempt.meta[TEST_HAS_FAILED_ALL_RETRIES],
              'true',
              'Last attempt should have the flag'
            )
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              ALWAYS_FAIL: 'true',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('bails out of EFD if the percentage of new tests is too high', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
            faulty_session_threshold: 0,
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {},
        }) // tests from ci-visibility/vitest-tests/early-flake-detection.mjs will be new

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'faulty')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 4)

            const newTests = tests.filter(
              test => test.meta[TEST_IS_NEW] === 'true'
            )
            // no new tests
            assert.strictEqual(newTests.length, 0)
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('is disabled if DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED is false', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // will be considered new
              'early flake detection does not retry if it is not new',
            ],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.strictEqual(tests.length, 4)

            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped',
            ])

            // new tests are detected but not retried
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(newTests.length, 3)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 1)
            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: 'false',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('does not run EFD if the known tests request fails', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTestsResponseCode(500)
        receiver.setKnownTests({})

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.strictEqual(tests.length, 4)

            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped',
            ])
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(newTests.length, 0)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 1)
            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('works when the cwd is not the repository root', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/subproject/vitest-test.mjs': [
              'context can report passed test', // no test will be considered new
            ],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            // no retries
            assert.strictEqual(tests.length, 1)

            assert.strictEqual(tests[0].meta[TEST_SUITE], 'ci-visibility/subproject/vitest-test.mjs')
            // it's not considered new
            assert.ok(!(TEST_IS_NEW in tests[0].meta))
          })

        childProcess = exec(
          '../../node_modules/.bin/vitest run',
          {
            cwd: `${cwd}/ci-visibility/subproject`,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more flags
              TEST_DIR: './vitest-test.mjs',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 0)
            done()
          }).catch(done)
        })
      })

      it('works with repeats config when EFD is disabled', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: false,
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection can retry tests that eventually fail', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // will be considered new
              'early flake detection does not retry if it is not new',
            ],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.strictEqual(tests.length, 8)

            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that eventually pass', // repeated twice
              'early flake detection can retry tests that always pass', // repeated twice
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped',
            ])
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            // all but one are considered new
            assert.strictEqual(newTests.length, 7)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 4) // 2 repetitions on 2 tests

            // vitest reports the test as failed if any of the repetitions fail, so we'll follow that
            // TODO: we might want to improve this
            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 3)

            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSessionEvent.meta))
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              SHOULD_REPEAT: '1',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('disables early flake detection if known tests should not be requested', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: false,
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // will be considered new
              'early flake detection does not retry if it is not new',
            ],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.strictEqual(tests.length, 4)

            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped',
            ])

            // new tests are not detected and not retried
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(newTests.length, 0)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 1)
            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('does not detect new tests if the response is invalid', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          'not-vitest': {},
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'faulty')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 4)

            const newTests = tests.filter(
              test => test.meta[TEST_IS_NEW] === 'true'
            )
            // no new tests
            assert.strictEqual(newTests.length, 0)
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )
        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })
    })

    // dynamic instrumentation only supported from >=2.0.0
    if (version === 'latest') {
      context('dynamic instrumentation', () => {
        it('does not activate it if DD_TEST_FAILED_TEST_REPLAY_ENABLED is set to false', (done) => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            di_enabled: true,
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

              assert.strictEqual(retriedTests.length, 1)
              const [retriedTest] = retriedTests

              const hasDebugTags = Object.keys(retriedTest.meta)
                .some(property =>
                  property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED
                )

              assert.strictEqual(hasDebugTags, false)
            })

          const logsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
              if (payloads.length > 0) {
                throw new Error('Unexpected logs')
              }
            }, 5000)

          childProcess = exec(
            './node_modules/.bin/vitest run --retry=1',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/dynamic-instrumentation*',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
                DD_TEST_FAILED_TEST_REPLAY_ENABLED: 'false',
              },
            }
          )

          childProcess.on('exit', () => {
            Promise.all([eventsPromise, logsPromise]).then(() => {
              done()
            }).catch(done)
          })
        })

        it('does not activate dynamic instrumentation if remote settings are disabled', (done) => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            di_enabled: false,
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

              assert.strictEqual(retriedTests.length, 1)
              const [retriedTest] = retriedTests
              const hasDebugTags = Object.keys(retriedTest.meta)
                .some(property =>
                  property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED
                )

              assert.strictEqual(hasDebugTags, false)
            })

          const logsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
              if (payloads.length > 0) {
                throw new Error('Unexpected logs')
              }
            }, 5000)

          childProcess = exec(
            './node_modules/.bin/vitest run --retry=1',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/dynamic-instrumentation*',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              },
            }
          )

          childProcess.on('exit', () => {
            Promise.all([eventsPromise, logsPromise]).then(() => {
              done()
            }).catch(done)
          })
        })

        it('runs retries with dynamic instrumentation', (done) => {
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
              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

              assert.strictEqual(retriedTests.length, 1)
              const [retriedTest] = retriedTests

              assert.strictEqual(retriedTest.meta[DI_ERROR_DEBUG_INFO_CAPTURED], 'true')

              assert.strictEqual(retriedTest.meta[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_FILE_SUFFIX}`]
                .endsWith('ci-visibility/vitest-tests/bad-sum.mjs'), true)
              assert.strictEqual(retriedTest.metrics[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_LINE_SUFFIX}`], 4)

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
              assert.match(diLog.ddtags, /git.repository_url:/)
              assert.match(diLog.ddtags, /git.commit.sha:/)
              assert.strictEqual(diLog.debugger.snapshot.language, 'javascript')
              assertObjectContains(diLog.debugger.snapshot.captures.lines['4'].locals, {
                a: {
                  type: 'number',
                  value: '11',
                },
                b: {
                  type: 'number',
                  value: '2',
                },
                localVar: {
                  type: 'number',
                  value: '10',
                },
              })
              spanIdByLog = diLog.dd.span_id
              traceIdByLog = diLog.dd.trace_id
              snapshotIdByLog = diLog.debugger.snapshot.id
            }, 5000)

          childProcess = exec(
            './node_modules/.bin/vitest run --retry=1',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/dynamic-instrumentation*',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
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

        it('does not crash if the retry does not hit the breakpoint', (done) => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            di_enabled: true,
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

              assert.strictEqual(retriedTests.length, 1)
              const [retriedTest] = retriedTests

              const hasDebugTags = Object.keys(retriedTest.meta)
                .some(property =>
                  property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED
                )

              assert.strictEqual(hasDebugTags, false)
            })

          const logsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
              if (payloads.length > 0) {
                throw new Error('Unexpected logs')
              }
            }, 5000)

          childProcess = exec(
            './node_modules/.bin/vitest run --retry=1',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/breakpoint-not-hit*',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              },
            }
          )

          childProcess.on('exit', () => {
            Promise.all([eventsPromise, logsPromise]).then(() => {
              done()
            }).catch(done)
          })
        })
      })
    }

    context('known tests without early flake detection', () => {
      it('detects new tests without retrying them', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: false,
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // will be considered new
              'early flake detection does not retry if it is not new',
            ],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.strictEqual(tests.length, 4)

            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped',
            ])
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            // all but one are considered new
            assert.strictEqual(newTests.length, 3)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 1)

            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSessionEvent.meta))
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 1)
            done()
          }).catch(done)
        })
      })
    })

    it('sets _dd.test.is_user_provided_service to true if DD_SERVICE is used', (done) => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(test => test.content)
          tests.forEach(test => {
            assert.strictEqual(test.meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'true')
          })
        })

      childProcess = exec(
        './node_modules/.bin/vitest run',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            DD_SERVICE: 'my-service',
          },
        }
      )

      childProcess.on('exit', (exitCode) => {
        eventsPromise.then(() => {
          assert.strictEqual(exitCode, 1)
          done()
        }).catch(done)
      })
    })

    if (version === 'latest') {
      context('test management', () => {
        context('attempt to fix', () => {
          beforeEach(() => {
            receiver.setTestManagementTests({
              vitest: {
                suites: {
                  'ci-visibility/vitest-tests/test-attempt-to-fix.mjs': {
                    tests: {
                      'attempt to fix tests can attempt to fix a test': {
                        properties: {
                          attempt_to_fix: true,
                        },
                      },
                    },
                  },
                },
              },
            })
          })

          const getTestAssertions = ({
            isAttemptingToFix,
            shouldAlwaysPass,
            shouldFailSometimes,
            isQuarantining,
            isDisabling,
          }) =>
            receiver
              .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                const testSession = events.find(event => event.type === 'test_session_end').content

                if (isAttemptingToFix) {
                  assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
                } else {
                  assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
                }

                const resourceNames = tests.map(span => span.resource)

                assertObjectContains(resourceNames,
                  [
                    'ci-visibility/vitest-tests/test-attempt-to-fix.mjs.attempt to fix tests can attempt to fix a test',
                  ]
                )

                const attemptedToFixTests = tests.filter(
                  test => test.meta[TEST_NAME] === 'attempt to fix tests can attempt to fix a test'
                )

                for (let i = 0; i < attemptedToFixTests.length; i++) {
                  const isFirstAttempt = i === 0
                  const isLastAttempt = i === attemptedToFixTests.length - 1
                  const test = attemptedToFixTests[i]
                  if (isQuarantining) {
                    assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
                  } else if (isDisabling) {
                    assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
                  }

                  if (isAttemptingToFix) {
                    assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
                    if (isFirstAttempt) {
                      assert.ok(!(TEST_IS_RETRY in test.meta))
                      assert.ok(!(TEST_RETRY_REASON in test.meta))
                      continue
                    }
                    assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
                    assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
                    if (isLastAttempt) {
                      if (shouldAlwaysPass) {
                        assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'true')
                      } else if (shouldFailSometimes) {
                        assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
                        assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in test.meta))
                      } else {
                        assert.strictEqual(test.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
                        assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
                      }
                    }
                  } else {
                    assert.ok(!(TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX in test.meta))
                    assert.ok(!(TEST_IS_RETRY in test.meta))
                    assert.ok(!(TEST_RETRY_REASON in test.meta))
                  }
                }
              })

          /**
           * @param {() => void} done
           * @param {{
           *   isAttemptingToFix?: boolean,
           *   shouldAlwaysPass?: boolean,
           *   isQuarantining?: boolean,
           *   shouldFailSometimes?: boolean,
           *   isDisabling?: boolean,
           *   extraEnvVars?: Record<string, string>
           * }} [options]
           */
          const runAttemptToFixTest = (done, {
            isAttemptingToFix,
            shouldAlwaysPass,
            isQuarantining,
            shouldFailSometimes,
            isDisabling,
            extraEnvVars = {},
          } = {}) => {
            let stdout = ''
            const testAssertionsPromise = getTestAssertions({
              isAttemptingToFix,
              shouldAlwaysPass,
              shouldFailSometimes,
              isQuarantining,
              isDisabling,
            })
            childProcess = exec(
              './node_modules/.bin/vitest run',
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  TEST_DIR: 'ci-visibility/vitest-tests/test-attempt-to-fix*',
                  NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
                  ...extraEnvVars,
                  ...(shouldAlwaysPass ? { SHOULD_ALWAYS_PASS: '1' } : {}),
                  ...(shouldFailSometimes ? { SHOULD_FAIL_SOMETIMES: '1' } : {}),
                },
              }
            )

            childProcess.stdout?.on('data', (data) => {
              stdout += data
            })

            childProcess.on('exit', (exitCode) => {
              testAssertionsPromise.then(() => {
                assert.match(stdout, /I am running/)
                if (shouldAlwaysPass || (isAttemptingToFix && isQuarantining) || (isAttemptingToFix && isDisabling)) {
                  assert.strictEqual(exitCode, 0)
                } else {
                  assert.strictEqual(exitCode, 1)
                }
                done()
              }).catch(done)
            })
          }

          it('can attempt to fix and mark last attempt as failed if every attempt fails', (done) => {
            receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

            runAttemptToFixTest(done, { isAttemptingToFix: true })
          })

          it('can attempt to fix and mark last attempt as passed if every attempt passes', (done) => {
            receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

            runAttemptToFixTest(done, { isAttemptingToFix: true, shouldAlwaysPass: true })
          })

          it('can attempt to fix and not mark last attempt if attempts both pass and fail', (done) => {
            receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

            runAttemptToFixTest(done, { isAttemptingToFix: true, shouldFailSometimes: true })
          })

          it('does not attempt to fix tests if test management is not enabled', (done) => {
            receiver.setSettings({ test_management: { enabled: false, attempt_to_fix_retries: 3 } })

            runAttemptToFixTest(done)
          })

          it('does not enable attempt to fix tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
            receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

            runAttemptToFixTest(done, { extraEnvVars: { DD_TEST_MANAGEMENT_ENABLED: '0' } })
          })

          it('does not fail retry if a test is quarantined', (done) => {
            receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
            receiver.setTestManagementTests({
              vitest: {
                suites: {
                  'ci-visibility/vitest-tests/test-attempt-to-fix.mjs': {
                    tests: {
                      'attempt to fix tests can attempt to fix a test': {
                        properties: {
                          attempt_to_fix: true,
                          quarantined: true,
                        },
                      },
                    },
                  },
                },
              },
            })

            runAttemptToFixTest(done, { isAttemptingToFix: true, isQuarantining: true })
          })

          it('does not fail retry if a test is disabled', (done) => {
            receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
            receiver.setTestManagementTests({
              vitest: {
                suites: {
                  'ci-visibility/vitest-tests/test-attempt-to-fix.mjs': {
                    tests: {
                      'attempt to fix tests can attempt to fix a test': {
                        properties: {
                          attempt_to_fix: true,
                          disabled: true,
                        },
                      },
                    },
                  },
                },
              },
            })

            runAttemptToFixTest(done, { isAttemptingToFix: true, isDisabling: true })
          })
        })

        context('disabled', () => {
          beforeEach(() => {
            receiver.setTestManagementTests({
              vitest: {
                suites: {
                  'ci-visibility/vitest-tests/test-disabled.mjs': {
                    tests: {
                      'disable tests can disable a test': {
                        properties: {
                          disabled: true,
                        },
                      },
                    },
                  },
                },
              },
            })
          })

          const getTestAssertions = (isDisabling) =>
            receiver
              .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                assert.strictEqual(tests.length, 1)

                const testSession = events.find(event => event.type === 'test_session_end').content

                if (isDisabling) {
                  assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
                } else {
                  assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
                }

                const resourceNames = tests.map(span => span.resource)

                assertObjectContains(resourceNames,
                  [
                    'ci-visibility/vitest-tests/test-disabled.mjs.disable tests can disable a test',
                  ]
                )

                const skippedTest = tests.find(
                  test => test.meta[TEST_NAME] === 'disable tests can disable a test'
                )

                if (isDisabling) {
                  assert.strictEqual(skippedTest.meta[TEST_STATUS], 'skip')
                  assert.strictEqual(skippedTest.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
                } else {
                  assert.strictEqual(skippedTest.meta[TEST_STATUS], 'fail')
                  assert.ok(!(TEST_MANAGEMENT_IS_DISABLED in skippedTest.meta))
                }
              })

          const runDisableTest = (done, isDisabling, extraEnvVars = {}) => {
            let stdout = ''
            const testAssertionsPromise = getTestAssertions(isDisabling)

            childProcess = exec(
              './node_modules/.bin/vitest run',
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  TEST_DIR: 'ci-visibility/vitest-tests/test-disabled*',
                  NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
                  ...extraEnvVars,
                },
              }
            )

            childProcess.stdout?.on('data', (data) => {
              stdout += data
            })

            childProcess.on('exit', (exitCode) => {
              testAssertionsPromise.then(() => {
                if (isDisabling) {
                  assert.doesNotMatch(stdout, /I am running/)
                  assert.strictEqual(exitCode, 0)
                } else {
                  assert.match(stdout, /I am running/)
                  assert.strictEqual(exitCode, 1)
                }
                done()
              }).catch(done)
            })
          }

          it('can disable tests', (done) => {
            receiver.setSettings({ test_management: { enabled: true } })

            runDisableTest(done, true)
          })

          it('fails if disable is not enabled', (done) => {
            receiver.setSettings({ test_management: { enabled: false } })

            runDisableTest(done, false)
          })

          it('does not disable tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
            receiver.setSettings({ test_management: { enabled: true } })

            runDisableTest(done, false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
          })
        })

        context('quarantine', () => {
          beforeEach(() => {
            receiver.setTestManagementTests({
              vitest: {
                suites: {
                  'ci-visibility/vitest-tests/test-quarantine.mjs': {
                    tests: {
                      'quarantine tests can quarantine a test': {
                        properties: {
                          quarantined: true,
                        },
                      },
                    },
                  },
                },
              },
            })
          })

          const getTestAssertions = (isQuarantining) =>
            receiver
              .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                assert.strictEqual(tests.length, 2)

                const testSession = events.find(event => event.type === 'test_session_end').content

                if (isQuarantining) {
                  assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
                } else {
                  assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
                }

                const resourceNames = tests.map(span => span.resource)

                assertObjectContains(resourceNames,
                  [
                    'ci-visibility/vitest-tests/test-quarantine.mjs.quarantine tests can quarantine a test',
                    'ci-visibility/vitest-tests/test-quarantine.mjs.quarantine tests can pass normally',
                  ]
                )

                const quarantinedTest = tests.find(
                  test => test.meta[TEST_NAME] === 'quarantine tests can quarantine a test'
                )

                if (isQuarantining) {
                  // TODO: do not flip the status of the test but still ignore failures
                  assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'pass')
                  assert.strictEqual(quarantinedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
                } else {
                  assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
                  assert.ok(!(TEST_MANAGEMENT_IS_QUARANTINED in quarantinedTest.meta))
                }
              })

          const runQuarantineTest = (done, isQuarantining, extraEnvVars = {}) => {
            let stdout = ''
            const testAssertionsPromise = getTestAssertions(isQuarantining)

            childProcess = exec(
              './node_modules/.bin/vitest run',
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  TEST_DIR: 'ci-visibility/vitest-tests/test-quarantine*',
                  NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
                  ...extraEnvVars,
                },
              }
            )

            childProcess.stdout?.on('data', (data) => {
              stdout += data
            })

            childProcess.on('exit', (exitCode) => {
              testAssertionsPromise.then(() => {
                // it runs regardless of the quarantine status
                assert.match(stdout, /I am running when quarantined/)
                if (isQuarantining) {
                  // exit code 0 even though one of the tests failed
                  assert.strictEqual(exitCode, 0)
                } else {
                  assert.strictEqual(exitCode, 1)
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
        })

        it('does not crash if the request to get test management tests fails', async () => {
          let testOutput = ''
          receiver.setSettings({
            test_management: { enabled: true },
            flaky_test_retries_enabled: false,
          })
          receiver.setTestManagementTestsResponseCode(500)

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              // it is not retried
              assert.strictEqual(tests.length, 1)
            })

          childProcess = exec(
            './node_modules/.bin/vitest run',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/test-attempt-to-fix*',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
                DD_TRACE_DEBUG: '1',
              },
            }
          )

          childProcess.stdout?.on('data', (chunk) => {
            testOutput += chunk.toString()
          })
          childProcess.stderr?.on('data', (chunk) => {
            testOutput += chunk.toString()
          })

          await Promise.all([
            once(childProcess, 'exit'),
            once(childProcess.stdout, 'end'),
            once(childProcess.stderr, 'end'),
            eventsPromise,
          ])
          assert.match(testOutput, /Test management tests could not be fetched/)
        })
      })
    }

    context('libraries capabilities', () => {
      it('adds capabilities to tests', (done) => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

            assert.ok(metadataDicts.length > 0)
            metadataDicts.forEach(metadata => {
              assert.ok(!Object.hasOwn(metadata.test, DD_CAPABILITIES_TEST_IMPACT_ANALYSIS))

              assertObjectContains(metadata.test, {
                [DD_CAPABILITIES_EARLY_FLAKE_DETECTION]: '1',
                [DD_CAPABILITIES_AUTO_TEST_RETRIES]: '1',
                [DD_CAPABILITIES_IMPACTED_TESTS]: '1',
                [DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE]: '1',
                [DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE]: '1',
                [DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX]: '5',
                [DD_CAPABILITIES_FAILED_TEST_REPLAY]: '1',
                // capabilities logic does not overwrite test session name
                [TEST_SESSION_NAME]: 'my-test-session-name',
              })
            })
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              DD_TEST_SESSION_NAME: 'my-test-session-name',
            },
          }
        )

        childProcess.on('exit', () => {
          eventsPromise.then(() => {
            done()
          }).catch(done)
        })
      })
    })

    context('impacted tests', () => {
      beforeEach(() => {
        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/impacted-test.mjs': [
              'impacted test can impacted test',
            ],
          },
        })
      })

      // Modify `impacted-test.mjs` to mark it as impacted
      before(() => {
        execSync('git checkout -b feature-branch', { cwd, stdio: 'ignore' })
        fs.writeFileSync(
          path.join(cwd, 'ci-visibility/vitest-tests/impacted-test.mjs'),
          `import { describe, test, expect } from 'vitest'
           describe('impacted test', () => {
             test('can impacted test', () => {
               assert.strictEqual(1 + 2, 4)
             })
           })`
        )
        execSync('git add ci-visibility/vitest-tests/impacted-test.mjs', { cwd, stdio: 'ignore' })
        execSync('git commit -m "modify impacted-test.mjs"', { cwd, stdio: 'ignore' })
      })

      after(() => {
        execSync('git checkout -', { cwd, stdio: 'ignore' })
        execSync('git branch -D feature-branch', { cwd, stdio: 'ignore' })
      })

      /**
       * @param {{
       *   isModified?: boolean,
       *   isEfd?: boolean,
       *   isNew?: boolean,
       * }} options
       */
      const getTestAssertions = ({ isModified, isEfd, isNew }) =>
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            if (isEfd) {
              assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
            } else {
              assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
            }

            const resourceNames = tests.map(span => span.resource)

            assertObjectContains(resourceNames,
              [
                'ci-visibility/vitest-tests/impacted-test.mjs.impacted test can impacted test',
              ]
            )

            const impactedTests = tests.filter(test =>
              test.meta[TEST_SOURCE_FILE] === 'ci-visibility/vitest-tests/impacted-test.mjs' &&
              test.meta[TEST_NAME] === 'impacted test can impacted test')

            if (isEfd) {
              assert.strictEqual(impactedTests.length, NUM_RETRIES_EFD + 1) // Retries + original test
            } else {
              assert.strictEqual(impactedTests.length, 1)
            }

            for (const impactedTest of impactedTests) {
              if (isModified) {
                assert.strictEqual(impactedTest.meta[TEST_IS_MODIFIED], 'true')
              } else {
                assert.ok(!(TEST_IS_MODIFIED in impactedTest.meta))
              }
              if (isNew) {
                assert.strictEqual(impactedTest.meta[TEST_IS_NEW], 'true')
              } else {
                assert.ok(!(TEST_IS_NEW in impactedTest.meta))
              }
            }

            if (isEfd) {
              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
              assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
              let retriedTestNew = 0
              let retriedTestsWithReason = 0
              retriedTests.forEach(test => {
                if (test.meta[TEST_IS_NEW] === 'true') {
                  retriedTestNew++
                }
                if (test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd) {
                  retriedTestsWithReason++
                }
              })
              assert.strictEqual(retriedTestNew, isNew ? NUM_RETRIES_EFD : 0)
              assert.strictEqual(retriedTestsWithReason, NUM_RETRIES_EFD)
            }
          })

      const runImpactedTest = (
        done,
        { isModified, isEfd = false, isNew = false },
        extraEnvVars = {}
      ) => {
        const testAssertionsPromise = getTestAssertions({ isModified, isEfd, isNew })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/impacted-test*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
              GITHUB_BASE_REF: '',
              ...extraEnvVars,
            },
          }
        )

        childProcess.on('exit', () => {
          testAssertionsPromise.then(done).catch(done)
        })
      }

      context('test is not new', () => {
        it('should be detected as impacted', (done) => {
          receiver.setSettings({ impacted_tests_enabled: true })

          runImpactedTest(done, { isModified: true })
        })

        it('should not be detected as impacted if disabled', (done) => {
          receiver.setSettings({ impacted_tests_enabled: false })

          runImpactedTest(done, { isModified: false })
        })

        it('should not be detected as impacted if DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED is false',
          (done) => {
            receiver.setSettings({ impacted_tests_enabled: true })

            runImpactedTest(done,
              { isModified: false },
              { DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED: '0' }
            )
          })
      })

      context('test is new', () => {
        it('should be retried and marked both as new and modified', (done) => {
          receiver.setKnownTests({
            vitest: {},
          })
          receiver.setSettings({
            impacted_tests_enabled: true,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD,
              },
            },
            known_tests_enabled: true,
          })
          runImpactedTest(done, { isModified: true, isEfd: true, isNew: true })
        })
      })
    })

    it('does not blow up when tinypool is used outside of a test', (done) => {
      childProcess = exec('node ./ci-visibility/run-tinypool.mjs', {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
      })
      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.on('exit', (code) => {
        assert.match(testOutput, /result 10/)
        assert.strictEqual(code, 0)
        done()
      })
    })

    context('programmatic api', () => {
      it('can report data using the vitest programmatic api', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSessionEvent = events.find(event => event.type === 'test_session_end')
            const testModuleEvent = events.find(event => event.type === 'test_module_end')
            const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
            const testEvents = events.filter(event => event.type === 'test')

            assert.strictEqual(testSessionEvent.content.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testModuleEvent.content.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testSessionEvent.content.meta[TEST_TYPE], 'test')
            assert.strictEqual(testModuleEvent.content.meta[TEST_TYPE], 'test')

            const testSuite = testSuiteEvents.find(
              suite => suite.content.resource ===
                'test_suite.ci-visibility/vitest-tests-programmatic-api/test-programmatic-api.mjs'
            )
            assert.strictEqual(testSuite.content.meta[TEST_STATUS], 'fail')

            assert.strictEqual(testEvents.length, 3)
          })

        childProcess = exec(
          'node run-programmatic-api.mjs',
          {
            cwd: `${cwd}/ci-visibility/vitest-tests-programmatic-api`,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              TEST_DIR: './test-programmatic-api*',
            },
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })
    })

    // Coverage report upload only works for >=2.0.0 (when vitest has proper coverage support)
    // v4 dropped support for Node 18
    if (version === 'latest' && NODE_MAJOR >= 20) {
      context('coverage report upload', () => {
        const gitCommitSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        const gitRepositoryUrl = 'https://github.com/datadog/test-repo.git'

        it('uploads coverage report when coverage_report_upload_enabled is true', async () => {
          receiver.setSettings({
            coverage_report_upload_enabled: true,
          })

          const coverageReportPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/cicovreprt', (payloads) => {
              assert.strictEqual(payloads.length, 1)

              const coverageReport = payloads[0]

              assert.ok(coverageReport.headers['content-type'].includes('multipart/form-data'))

              assert.strictEqual(coverageReport.coverageFile.name, 'coverage')
              assert.ok(coverageReport.coverageFile.content.includes('SF:')) // LCOV format

              assert.strictEqual(coverageReport.eventFile.name, 'event')
              assert.strictEqual(coverageReport.eventFile.content.type, 'coverage_report')
              assert.strictEqual(coverageReport.eventFile.content.format, 'lcov')
              assert.strictEqual(coverageReport.eventFile.content[GIT_COMMIT_SHA], gitCommitSha)
              assert.strictEqual(coverageReport.eventFile.content[GIT_REPOSITORY_URL], gitRepositoryUrl)
            })

          childProcess = exec(
            './node_modules/.bin/vitest run --coverage',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
                COVERAGE_PROVIDER: 'v8',
                TEST_DIR: 'ci-visibility/vitest-tests/coverage-test.mjs',
                DD_GIT_COMMIT_SHA: gitCommitSha,
                DD_GIT_REPOSITORY_URL: gitRepositoryUrl,
              },
            }
          )

          await Promise.all([
            coverageReportPromise,
            once(childProcess, 'exit'),
          ])
        })

        it('sends coverage_upload.request telemetry metric when coverage is uploaded', async () => {
          receiver.setSettings({
            coverage_report_upload_enabled: true,
          })
          receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })

          const telemetryPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/apmtelemetry'), (payloads) => {
              const telemetryMetrics = payloads.flatMap(({ payload }) => payload.payload.series)

              const coverageUploadMetric = telemetryMetrics.find(
                ({ metric }) => metric === TELEMETRY_COVERAGE_UPLOAD
              )

              assert.ok(coverageUploadMetric, 'coverage_upload.request telemetry metric should be sent')
            })

          childProcess = exec(
            './node_modules/.bin/vitest run --coverage',
            {
              cwd,
              env: {
                ...getCiVisEvpProxyConfig(receiver.port),
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
                DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'true',
                COVERAGE_PROVIDER: 'v8',
                TEST_DIR: 'ci-visibility/vitest-tests/coverage-test.mjs',
                DD_GIT_COMMIT_SHA: gitCommitSha,
                DD_GIT_REPOSITORY_URL: gitRepositoryUrl,
              },
            }
          )

          await Promise.all([
            once(childProcess, 'exit'),
            telemetryPromise,
          ])
        })

        it('does not upload coverage report when coverage_report_upload_enabled is false', async () => {
          receiver.setSettings({
            coverage_report_upload_enabled: false,
          })

          let coverageReportUploaded = false
          receiver.assertPayloadReceived(() => {
            coverageReportUploaded = true
          }, ({ url }) => url === '/api/v2/cicovreprt')

          childProcess = exec(
            './node_modules/.bin/vitest run --coverage',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
                COVERAGE_PROVIDER: 'v8',
                TEST_DIR: 'ci-visibility/vitest-tests/coverage-test.mjs',
                DD_GIT_COMMIT_SHA: gitCommitSha,
                DD_GIT_REPOSITORY_URL: gitRepositoryUrl,
              },
            }
          )

          await once(childProcess, 'exit')

          assert.strictEqual(coverageReportUploaded, false, 'coverage report should not be uploaded')
        })
      })
    }
  })
})
