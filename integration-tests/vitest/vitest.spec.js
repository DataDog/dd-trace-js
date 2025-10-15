'use strict'

const { once } = require('node:events')
const { exec, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const { assert } = require('chai')

const {
  createSandbox,
  getCiVisAgentlessConfig
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
  DD_CAPABILITIES_IMPACTED_TESTS
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')

const NUM_RETRIES_EFD = 3

const versions = ['1.6.0', 'latest']

const linePctMatchRegex = /Lines\s+:\s+([\d.]+)%/

versions.forEach((version) => {
  describe(`vitest@${version}`, () => {
    let sandbox, cwd, receiver, childProcess, testOutput

    before(async function () {
      sandbox = await createSandbox([
        `vitest@${version}`,
        `@vitest/coverage-istanbul@${version}`,
        `@vitest/coverage-v8@${version}`,
        'tinypool'
      ], true)
      cwd = sandbox.folder
    })

    after(async () => {
      await sandbox.remove()
    })

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async () => {
      testOutput = ''
      childProcess.kill()
      await receiver.stop()
    })

    it('can run and report tests', (done) => {
      receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
        const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

        metadataDicts.forEach(metadata => {
          for (const testLevel of TEST_LEVEL_EVENT_TYPES) {
            assert.equal(metadata[testLevel][TEST_SESSION_NAME], 'my-test-session')
          }
        })

        const events = payloads.flatMap(({ payload }) => payload.events)

        const testSessionEvent = events.find(event => event.type === 'test_session_end')
        const testModuleEvent = events.find(event => event.type === 'test_module_end')
        const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
        const testEvents = events.filter(event => event.type === 'test')

        assert.include(testSessionEvent.content.resource, 'test_session.vitest run')
        assert.equal(testSessionEvent.content.meta[TEST_STATUS], 'fail')
        assert.include(testModuleEvent.content.resource, 'test_module.vitest run')
        assert.equal(testModuleEvent.content.meta[TEST_STATUS], 'fail')
        assert.equal(testSessionEvent.content.meta[TEST_TYPE], 'test')
        assert.equal(testModuleEvent.content.meta[TEST_TYPE], 'test')

        const passedSuite = testSuiteEvents.find(
          suite => suite.content.resource === 'test_suite.ci-visibility/vitest-tests/test-visibility-passed-suite.mjs'
        )
        assert.equal(passedSuite.content.meta[TEST_STATUS], 'pass')

        const failedSuite = testSuiteEvents.find(
          suite => suite.content.resource === 'test_suite.ci-visibility/vitest-tests/test-visibility-failed-suite.mjs'
        )
        assert.equal(failedSuite.content.meta[TEST_STATUS], 'fail')

        const failedSuiteHooks = testSuiteEvents.find(
          suite => suite.content.resource === 'test_suite.ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs'
        )
        assert.equal(failedSuiteHooks.content.meta[TEST_STATUS], 'fail')

        assert.includeMembers(testEvents.map(test => test.content.resource),
          [
            'ci-visibility/vitest-tests/test-visibility-failed-suite.mjs' +
            '.test-visibility-failed-suite-first-describe can report failed test',
            'ci-visibility/vitest-tests/test-visibility-failed-suite.mjs' +
            '.test-visibility-failed-suite-first-describe can report more',
            'ci-visibility/vitest-tests/test-visibility-failed-suite.mjs' +
            '.test-visibility-failed-suite-second-describe can report passed test',
            'ci-visibility/vitest-tests/test-visibility-failed-suite.mjs' +
            '.test-visibility-failed-suite-second-describe can report more',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.context can report passed test',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.context can report more',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can report passed test',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can report more',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can skip',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can todo',
            'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.context can report failed test',
            'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.context can report more',
            'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.other context can report passed test',
            'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.other context can report more',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.no suite',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.skip no suite',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.programmatic skip no suite'
          ]
        )

        const failedTests = testEvents.filter(test => test.content.meta[TEST_STATUS] === 'fail')

        assert.includeMembers(
          failedTests.map(test => test.content.resource),
          [
            'ci-visibility/vitest-tests/test-visibility-failed-suite.mjs' +
            '.test-visibility-failed-suite-first-describe can report failed test',
            'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.context can report failed test',
            'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.context can report more',
            'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.other context can report passed test',
            'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.other context can report more'
          ]
        )

        const skippedTests = testEvents.filter(test => test.content.meta[TEST_STATUS] === 'skip')

        assert.includeMembers(
          skippedTests.map(test => test.content.resource),
          [
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can skip',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can todo',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can programmatic skip'
          ]
        )

        testEvents.forEach(test => {
          assert.equal(test.content.meta[TEST_COMMAND], 'vitest run')
          assert.exists(test.content.metrics[DD_HOST_CPU_COUNT])
          assert.equal(test.content.meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'false')
        })

        testSuiteEvents.forEach(testSuite => {
          assert.equal(testSuite.content.meta[TEST_COMMAND], 'vitest run')
          assert.isTrue(
            testSuite.content.meta[TEST_SOURCE_FILE].startsWith('ci-visibility/vitest-tests/test-visibility')
          )
          assert.equal(testSuite.content.metrics[TEST_SOURCE_START], 1)
          assert.exists(testSuite.content.metrics[DD_HOST_CPU_COUNT])
        })
        // TODO: check error messages
      }).then(() => done()).catch(done)

      childProcess = exec(
        './node_modules/.bin/vitest run',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more flags
            DD_TEST_SESSION_NAME: 'my-test-session',
            DD_SERVICE: undefined
          },
          stdio: 'pipe'
        }
      )
    })

    context('flaky test retries', () => {
      it('can retry flaky tests', (done) => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: {
            enabled: false
          }
        })

        receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testEvents = events.filter(event => event.type === 'test')
          assert.equal(testEvents.length, 11)
          assert.includeMembers(testEvents.map(test => test.content.resource), [
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            // passes at the third retry
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            // never passes
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            // passes on the first try
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries does not retry if unnecessary'
          ])
          const eventuallyPassingTest = testEvents.filter(
            test => test.content.resource ===
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass'
          )
          assert.equal(eventuallyPassingTest.length, 4)
          assert.equal(eventuallyPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'fail').length, 3)
          assert.equal(eventuallyPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'pass').length, 1)
          assert.equal(eventuallyPassingTest.filter(test => test.content.meta[TEST_IS_RETRY] === 'true').length, 3)
          assert.equal(eventuallyPassingTest.filter(test =>
            test.content.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          ).length, 3)

          const neverPassingTest = testEvents.filter(
            test => test.content.resource ===
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass'
          )
          assert.equal(neverPassingTest.length, 6)
          assert.equal(neverPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'fail').length, 6)
          assert.equal(neverPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'pass').length, 0)
          assert.equal(neverPassingTest.filter(test => test.content.meta[TEST_IS_RETRY] === 'true').length, 5)
          assert.equal(neverPassingTest.filter(test =>
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
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init' // ESM requires more flags
            },
            stdio: 'pipe'
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
            enabled: false
          }
        })

        receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testEvents = events.filter(event => event.type === 'test')
          assert.equal(testEvents.length, 3)
          assert.includeMembers(testEvents.map(test => test.content.resource), [
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries does not retry if unnecessary'
          ])
          assert.equal(testEvents.filter(
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
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init' // ESM requires more flags
            },
            stdio: 'pipe'
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
            enabled: false
          }
        })

        receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testEvents = events.filter(event => event.type === 'test')
          assert.equal(testEvents.length, 5)
          assert.includeMembers(testEvents.map(test => test.content.resource), [
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries does not retry if unnecessary'
          ])
          assert.equal(testEvents.filter(
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
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: 1,
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init' // ESM requires more flags
            },
            stdio: 'pipe'
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
          assert.equal(test.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
          assert.equal(testSuite.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
        }, 25000)

      childProcess = exec(
        '../../node_modules/.bin/vitest run',
        {
          cwd: `${cwd}/ci-visibility/subproject`,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            TEST_DIR: './vitest-test.mjs'
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

    // total code coverage only works for >=2.0.0
    if (version === 'latest') {
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
                TEST_DIR: 'ci-visibility/vitest-tests/coverage-test.mjs'
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

          await Promise.all([
            once(childProcess, 'exit'),
            eventsPromise
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
              TEST_DIR: 'ci-visibility/vitest-tests/coverage-test-zero.mjs'
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

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise
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
              '5s': NUM_RETRIES_EFD
            }
          },
          known_tests_enabled: true
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection can retry tests that eventually fail', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // skipped so not retried
              'early flake detection does not retry if it is not new'
            ]
          }
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.equal(tests.length, 14)

            assert.includeMembers(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually fail',
              'early flake detection can retry tests that eventually fail',
              'early flake detection can retry tests that eventually fail',
              'early flake detection can retry tests that eventually fail',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped'
            ])
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            // 4 executions of the 3 new tests + 1 new skipped test (not retried)
            assert.equal(newTests.length, 13)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.equal(retriedTests.length, 9) // 3 retries of the 3 new tests

            retriedTests.forEach(test => {
              assert.equal(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
            })

            // exit code should be 0 and test session should be reported as passed,
            // even though there are some failing executions
            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.equal(failedTests.length, 3)
            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.propertyVal(testSessionEvent.meta, TEST_STATUS, 'pass')
            assert.propertyVal(testSessionEvent.meta, TEST_EARLY_FLAKE_ENABLED, 'true')
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              SHOULD_ADD_EVENTUALLY_FAIL: '1'
            },
            stdio: 'pipe'
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.equal(exitCode, 0)
            done()
          }).catch(done)
        })
      })

      it('fails if all the attempts fail', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD
            }
          },
          known_tests_enabled: true
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // skipped so not retried
              'early flake detection does not retry if it is not new'
            ]
          }
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.equal(tests.length, 10)

            assert.includeMembers(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped'
            ])
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            // 4 executions of the 2 new tests + 1 new skipped test (not retried)
            assert.equal(newTests.length, 9)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.equal(retriedTests.length, 6) // 3 retries of the 2 new tests

            // the multiple attempts did not result in a single pass,
            // so the test session should be reported as failed
            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.equal(failedTests.length, 6)
            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.propertyVal(testSessionEvent.meta, TEST_STATUS, 'fail')
            assert.propertyVal(testSessionEvent.meta, TEST_EARLY_FLAKE_ENABLED, 'true')
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              ALWAYS_FAIL: 'true'
            },
            stdio: 'pipe'
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.equal(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('bails out of EFD if the percentage of new tests is too high', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD
            },
            faulty_session_threshold: 0
          },
          known_tests_enabled: true
        })

        receiver.setKnownTests({
          vitest: {}
        }) // tests from ci-visibility/vitest-tests/early-flake-detection.mjs will be new

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ABORT_REASON, 'faulty')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.equal(tests.length, 4)

            const newTests = tests.filter(
              test => test.meta[TEST_IS_NEW] === 'true'
            )
            // no new tests
            assert.equal(newTests.length, 0)
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init'
            },
            stdio: 'pipe'
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.equal(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('is disabled if DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED is false', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD
            }
          },
          known_tests_enabled: true
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // will be considered new
              'early flake detection does not retry if it is not new'
            ]
          }
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.equal(tests.length, 4)

            assert.includeMembers(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped'
            ])

            // new tests are detected but not retried
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.equal(newTests.length, 3)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.equal(retriedTests.length, 0)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.equal(failedTests.length, 1)
            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.equal(testSessionEvent.meta[TEST_STATUS], 'fail')
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: 'false'
            },
            stdio: 'pipe'
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.equal(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('does not run EFD if the known tests request fails', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD
            }
          },
          known_tests_enabled: true
        })

        receiver.setKnownTestsResponseCode(500)
        receiver.setKnownTests({})

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.equal(tests.length, 4)

            assert.includeMembers(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped'
            ])
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.equal(newTests.length, 0)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.equal(retriedTests.length, 0)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.equal(failedTests.length, 1)
            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.equal(testSessionEvent.meta[TEST_STATUS], 'fail')
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init'
            },
            stdio: 'pipe'
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.equal(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('works when the cwd is not the repository root', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD
            }
          },
          known_tests_enabled: true
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/subproject/vitest-test.mjs': [
              'context can report passed test' // no test will be considered new
            ]
          }
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            // no retries
            assert.equal(tests.length, 1)

            assert.propertyVal(tests[0].meta, TEST_SUITE, 'ci-visibility/subproject/vitest-test.mjs')
            // it's not considered new
            assert.notProperty(tests[0].meta, TEST_IS_NEW)
          })

        childProcess = exec(
          '../../node_modules/.bin/vitest run',
          {
            cwd: `${cwd}/ci-visibility/subproject`,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more flags
              TEST_DIR: './vitest-test.mjs'
            },
            stdio: 'inherit'
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.equal(exitCode, 0)
            done()
          }).catch(done)
        })
      })

      it('works with repeats config when EFD is disabled', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: false
          },
          known_tests_enabled: true
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection can retry tests that eventually fail', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // will be considered new
              'early flake detection does not retry if it is not new'
            ]
          }
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.equal(tests.length, 8)

            assert.includeMembers(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass', // repeated twice
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass', // repeated twice
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped'
            ])
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            // all but one are considered new
            assert.equal(newTests.length, 7)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.equal(retriedTests.length, 4) // 2 repetitions on 2 tests

            // vitest reports the test as failed if any of the repetitions fail, so we'll follow that
            // TODO: we might want to improve this
            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.equal(failedTests.length, 3)

            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.propertyVal(testSessionEvent.meta, TEST_STATUS, 'fail')
            assert.notProperty(testSessionEvent.meta, TEST_EARLY_FLAKE_ENABLED)
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              SHOULD_REPEAT: '1'
            },
            stdio: 'pipe'
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.equal(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('disables early flake detection if known tests should not be requested', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD
            }
          },
          known_tests_enabled: false
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // will be considered new
              'early flake detection does not retry if it is not new'
            ]
          }
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.equal(tests.length, 4)

            assert.includeMembers(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped'
            ])

            // new tests are not detected and not retried
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.equal(newTests.length, 0)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.equal(retriedTests.length, 0)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.equal(failedTests.length, 1)
            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.equal(testSessionEvent.meta[TEST_STATUS], 'fail')
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init'
            },
            stdio: 'pipe'
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.equal(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('does not detect new tests if the response is invalid', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true
          },
          known_tests_enabled: true
        })

        receiver.setKnownTests({
          'not-vitest': {}
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ABORT_REASON, 'faulty')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.equal(tests.length, 4)

            const newTests = tests.filter(
              test => test.meta[TEST_IS_NEW] === 'true'
            )
            // no new tests
            assert.equal(newTests.length, 0)
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init'
            },
            stdio: 'pipe'
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
                .some(property =>
                  property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED
                )

              assert.isFalse(hasDebugTags)
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
                DD_TEST_FAILED_TEST_REPLAY_ENABLED: 'false'
              },
              stdio: 'pipe'
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
                .some(property =>
                  property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED
                )

              assert.isFalse(hasDebugTags)
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
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init'
              },
              stdio: 'pipe'
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
                  .endsWith('ci-visibility/vitest-tests/bad-sum.mjs')
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
              assert.include(diLog.ddtags, 'git.repository_url:')
              assert.include(diLog.ddtags, 'git.commit.sha:')
              assert.equal(diLog.debugger.snapshot.language, 'javascript')
              assert.deepInclude(diLog.debugger.snapshot.captures.lines['4'].locals, {
                a: {
                  type: 'number',
                  value: '11'
                },
                b: {
                  type: 'number',
                  value: '2'
                },
                localVar: {
                  type: 'number',
                  value: '10'
                }
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
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init'
              },
              stdio: 'pipe'
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
                .some(property =>
                  property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED
                )

              assert.isFalse(hasDebugTags)
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
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init'
              },
              stdio: 'pipe'
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
            enabled: false
          },
          known_tests_enabled: true
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // will be considered new
              'early flake detection does not retry if it is not new'
            ]
          }
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.equal(tests.length, 4)

            assert.includeMembers(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped'
            ])
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            // all but one are considered new
            assert.equal(newTests.length, 3)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.equal(retriedTests.length, 0)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.equal(failedTests.length, 1)

            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.propertyVal(testSessionEvent.meta, TEST_STATUS, 'fail')
            assert.notProperty(testSessionEvent.meta, TEST_EARLY_FLAKE_ENABLED)
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init'
            },
            stdio: 'pipe'
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.equal(exitCode, 1)
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
            assert.equal(test.meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'true')
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
            DD_SERVICE: 'my-service'
          },
          stdio: 'pipe'
        }
      )

      childProcess.on('exit', (exitCode) => {
        eventsPromise.then(() => {
          assert.equal(exitCode, 1)
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
                          attempt_to_fix: true
                        }
                      }
                    }
                  }
                }
              }
            })
          })

          const getTestAssertions = ({
            isAttemptingToFix,
            shouldAlwaysPass,
            shouldFailSometimes,
            isQuarantining,
            isDisabling
          }) =>
            receiver
              .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                const testSession = events.find(event => event.type === 'test_session_end').content

                if (isAttemptingToFix) {
                  assert.propertyVal(testSession.meta, TEST_MANAGEMENT_ENABLED, 'true')
                } else {
                  assert.notProperty(testSession.meta, TEST_MANAGEMENT_ENABLED)
                }

                const resourceNames = tests.map(span => span.resource)

                assert.includeMembers(resourceNames,
                  [
                    'ci-visibility/vitest-tests/test-attempt-to-fix.mjs.attempt to fix tests can attempt to fix a test'
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
                    assert.propertyVal(test.meta, TEST_MANAGEMENT_IS_QUARANTINED, 'true')
                  } else if (isDisabling) {
                    assert.propertyVal(test.meta, TEST_MANAGEMENT_IS_DISABLED, 'true')
                  }

                  if (isAttemptingToFix) {
                    assert.propertyVal(test.meta, TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX, 'true')
                    if (isFirstAttempt) {
                      assert.notProperty(test.meta, TEST_IS_RETRY)
                      assert.notProperty(test.meta, TEST_RETRY_REASON)
                      continue
                    }
                    assert.propertyVal(test.meta, TEST_IS_RETRY, 'true')
                    assert.propertyVal(test.meta, TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.atf)
                    if (isLastAttempt) {
                      if (shouldAlwaysPass) {
                        assert.propertyVal(test.meta, TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'true')
                      } else if (shouldFailSometimes) {
                        assert.propertyVal(test.meta, TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'false')
                        assert.notProperty(test.meta, TEST_HAS_FAILED_ALL_RETRIES)
                      } else {
                        assert.propertyVal(test.meta, TEST_HAS_FAILED_ALL_RETRIES, 'true')
                        assert.propertyVal(test.meta, TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'false')
                      }
                    }
                  } else {
                    assert.notProperty(test.meta, TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX)
                    assert.notProperty(test.meta, TEST_IS_RETRY)
                    assert.notProperty(test.meta, TEST_RETRY_REASON)
                  }
                }
              })

          const runAttemptToFixTest = (done, {
            isAttemptingToFix,
            shouldAlwaysPass,
            isQuarantining,
            shouldFailSometimes,
            isDisabling,
            extraEnvVars = {}
          } = {}) => {
            let stdout = ''
            const testAssertionsPromise = getTestAssertions({
              isAttemptingToFix,
              shouldAlwaysPass,
              shouldFailSometimes,
              isQuarantining,
              isDisabling
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
                  ...(shouldFailSometimes ? { SHOULD_FAIL_SOMETIMES: '1' } : {})
                },
                stdio: 'inherit'
              }
            )

            childProcess.stdout.on('data', (data) => {
              stdout += data
            })

            childProcess.on('exit', (exitCode) => {
              testAssertionsPromise.then(() => {
                assert.include(stdout, 'I am running')
                if (shouldAlwaysPass || (isAttemptingToFix && isQuarantining) || (isAttemptingToFix && isDisabling)) {
                  assert.equal(exitCode, 0)
                } else {
                  assert.equal(exitCode, 1)
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
                          quarantined: true
                        }
                      }
                    }
                  }
                }
              }
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
                          disabled: true
                        }
                      }
                    }
                  }
                }
              }
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
                          disabled: true
                        }
                      }
                    }
                  }
                }
              }
            })
          })

          const getTestAssertions = (isDisabling) =>
            receiver
              .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                assert.equal(tests.length, 1)

                const testSession = events.find(event => event.type === 'test_session_end').content

                if (isDisabling) {
                  assert.propertyVal(testSession.meta, TEST_MANAGEMENT_ENABLED, 'true')
                } else {
                  assert.notProperty(testSession.meta, TEST_MANAGEMENT_ENABLED)
                }

                const resourceNames = tests.map(span => span.resource)

                assert.includeMembers(resourceNames,
                  [
                    'ci-visibility/vitest-tests/test-disabled.mjs.disable tests can disable a test'
                  ]
                )

                const skippedTest = tests.find(
                  test => test.meta[TEST_NAME] === 'disable tests can disable a test'
                )

                if (isDisabling) {
                  assert.equal(skippedTest.meta[TEST_STATUS], 'skip')
                  assert.propertyVal(skippedTest.meta, TEST_MANAGEMENT_IS_DISABLED, 'true')
                } else {
                  assert.equal(skippedTest.meta[TEST_STATUS], 'fail')
                  assert.notProperty(skippedTest.meta, TEST_MANAGEMENT_IS_DISABLED)
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
                  ...extraEnvVars
                },
                stdio: 'inherit'
              }
            )

            childProcess.stdout.on('data', (data) => {
              stdout += data
            })

            childProcess.on('exit', (exitCode) => {
              testAssertionsPromise.then(() => {
                if (isDisabling) {
                  assert.notInclude(stdout, 'I am running')
                  assert.equal(exitCode, 0)
                } else {
                  assert.include(stdout, 'I am running')
                  assert.equal(exitCode, 1)
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
                          quarantined: true
                        }
                      }
                    }
                  }
                }
              }
            })
          })

          const getTestAssertions = (isQuarantining) =>
            receiver
              .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                assert.equal(tests.length, 2)

                const testSession = events.find(event => event.type === 'test_session_end').content

                if (isQuarantining) {
                  assert.propertyVal(testSession.meta, TEST_MANAGEMENT_ENABLED, 'true')
                } else {
                  assert.notProperty(testSession.meta, TEST_MANAGEMENT_ENABLED)
                }

                const resourceNames = tests.map(span => span.resource)

                assert.includeMembers(resourceNames,
                  [
                    'ci-visibility/vitest-tests/test-quarantine.mjs.quarantine tests can quarantine a test',
                    'ci-visibility/vitest-tests/test-quarantine.mjs.quarantine tests can pass normally'
                  ]
                )

                const quarantinedTest = tests.find(
                  test => test.meta[TEST_NAME] === 'quarantine tests can quarantine a test'
                )

                if (isQuarantining) {
                  // TODO: do not flip the status of the test but still ignore failures
                  assert.equal(quarantinedTest.meta[TEST_STATUS], 'pass')
                  assert.propertyVal(quarantinedTest.meta, TEST_MANAGEMENT_IS_QUARANTINED, 'true')
                } else {
                  assert.equal(quarantinedTest.meta[TEST_STATUS], 'fail')
                  assert.notProperty(quarantinedTest.meta, TEST_MANAGEMENT_IS_QUARANTINED)
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
                  ...extraEnvVars
                },
                stdio: 'inherit'
              }
            )

            childProcess.stdout.on('data', (data) => {
              stdout += data
            })

            childProcess.on('exit', (exitCode) => {
              testAssertionsPromise.then(() => {
                // it runs regardless of the quarantine status
                assert.include(stdout, 'I am running when quarantined')
                if (isQuarantining) {
                  // exit code 0 even though one of the tests failed
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
        })
      })
    }

    context('libraries capabilities', () => {
      it('adds capabilities to tests', (done) => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

            assert.isNotEmpty(metadataDicts)
            metadataDicts.forEach(metadata => {
              assert.equal(metadata.test[DD_CAPABILITIES_TEST_IMPACT_ANALYSIS], undefined)
              assert.equal(metadata.test[DD_CAPABILITIES_EARLY_FLAKE_DETECTION], '1')
              assert.equal(metadata.test[DD_CAPABILITIES_AUTO_TEST_RETRIES], '1')
              assert.equal(metadata.test[DD_CAPABILITIES_IMPACTED_TESTS], '1')
              assert.equal(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE], '1')
              assert.equal(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE], '1')
              assert.equal(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX], '5')
              assert.equal(metadata.test[DD_CAPABILITIES_FAILED_TEST_REPLAY], '1')
              // capabilities logic does not overwrite test session name
              assert.equal(metadata.test[TEST_SESSION_NAME], 'my-test-session-name')
            })
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              DD_TEST_SESSION_NAME: 'my-test-session-name'
            },
            stdio: 'pipe'
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
              'impacted test can impacted test'
            ]
          }
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
               expect(1 + 2).to.equal(4)
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

      const getTestAssertions = ({ isModified, isEfd, isNew }) =>
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            if (isEfd) {
              assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')
            } else {
              assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)
            }

            const resourceNames = tests.map(span => span.resource)

            assert.includeMembers(resourceNames,
              [
                'ci-visibility/vitest-tests/impacted-test.mjs.impacted test can impacted test'
              ]
            )

            const impactedTests = tests.filter(test =>
              test.meta[TEST_SOURCE_FILE] === 'ci-visibility/vitest-tests/impacted-test.mjs' &&
              test.meta[TEST_NAME] === 'impacted test can impacted test')

            if (isEfd) {
              assert.equal(impactedTests.length, NUM_RETRIES_EFD + 1) // Retries + original test
            } else {
              assert.equal(impactedTests.length, 1)
            }

            for (const impactedTest of impactedTests) {
              if (isModified) {
                assert.propertyVal(impactedTest.meta, TEST_IS_MODIFIED, 'true')
              } else {
                assert.notProperty(impactedTest.meta, TEST_IS_MODIFIED)
              }
              if (isNew) {
                assert.propertyVal(impactedTest.meta, TEST_IS_NEW, 'true')
              } else {
                assert.notProperty(impactedTest.meta, TEST_IS_NEW)
              }
            }

            if (isEfd) {
              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
              assert.equal(retriedTests.length, NUM_RETRIES_EFD)
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
              assert.equal(retriedTestNew, isNew ? NUM_RETRIES_EFD : 0)
              assert.equal(retriedTestsWithReason, NUM_RETRIES_EFD)
            }
          })

      const runImpactedTest = (
        done,
        { isModified, isEfd = false, isParallel = false, isNew = false },
        extraEnvVars = {}
      ) => {
        const testAssertionsPromise = getTestAssertions({ isModified, isEfd, isParallel, isNew })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/impacted-test*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
              GITHUB_BASE_REF: '',
              ...extraEnvVars
            },
            stdio: 'inherit'
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
            vitest: {}
          })
          receiver.setSettings({
            impacted_tests_enabled: true,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD
              }
            },
            known_tests_enabled: true
          })
          runImpactedTest(done, { isModified: true, isEfd: true, isNew: true })
        })
      })
    })

    it('does not blow up when tinypool is used outside of a test', (done) => {
      childProcess = exec('node ./ci-visibility/run-tinypool.mjs', {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
        stdio: 'pipe'
      })
      childProcess.stdout.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.on('exit', (code) => {
        assert.include(testOutput, 'result 10')
        assert.equal(code, 0)
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

            assert.equal(testSessionEvent.content.meta[TEST_STATUS], 'fail')
            assert.equal(testModuleEvent.content.meta[TEST_STATUS], 'fail')
            assert.equal(testSessionEvent.content.meta[TEST_TYPE], 'test')
            assert.equal(testModuleEvent.content.meta[TEST_TYPE], 'test')

            const testSuite = testSuiteEvents.find(
              suite => suite.content.resource ===
                'test_suite.ci-visibility/vitest-tests-programmatic-api/test-programmatic-api.mjs'
            )
            assert.equal(testSuite.content.meta[TEST_STATUS], 'fail')

            assert.equal(testEvents.length, 3)
          })

        childProcess = exec(
          'node run-programmatic-api.mjs',
          {
            cwd: `${cwd}/ci-visibility/vitest-tests-programmatic-api`,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              TEST_DIR: './test-programmatic-api*'
            },
            stdio: 'pipe'
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit')
        ])
      })
    })
  })
})
