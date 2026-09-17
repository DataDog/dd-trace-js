'use strict'

const assert = require('node:assert')
const { exec } = require('node:child_process')
const { once } = require('node:events')
const { inspect } = require('node:util')

const {
  TEST_STATUS,
  TEST_FINAL_STATUS,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_RETRY_REASON,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_NAME,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_RETRY_REASON_TYPES,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { assertObjectContains, getCiVisAgentlessConfig } = require('../helpers')
const {
  PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT,
  describePlaywrightTestManagement,
} = require('./playwright-test-management')

const ATF_MANAGEMENT_TESTS = {
  playwright: {
    suites: {
      'attempt-to-fix-test.js': {
        tests: {
          'attempt to fix should attempt to fix failed test': {
            properties: {
              attempt_to_fix: true,
            },
          },
          'attempt to fix should attempt to fix passed test': {
            properties: {
              attempt_to_fix: true,
            },
          },
        },
      },
    },
  },
}

describePlaywrightTestManagement(({ contextNewVersions, it, runtime }) => {
  contextNewVersions('known tests without early flake detection', () => {
    it('detects new tests without retrying them', async (receiver, run) => {
      receiver.setSettings({
        known_tests_enabled: true,
      })

      receiver.setKnownTests(
        {
          playwright: {
            'landing-page-test.js': [
              // it will be considered new
              // 'highest-level-describe  leading and trailing spaces    should work with passing tests',
              'highest-level-describe  leading and trailing spaces    should work with skipped tests',
              'highest-level-describe  leading and trailing spaces    should work with fixme',
              'highest-level-describe  leading and trailing spaces    should work with annotated tests',
            ],
            'skipped-suite-test.js': [
              'should work with fixme root',
            ],
            'todo-list-page-test.js': [
              'playwright should work with failing tests',
              'should work with fixme root',
            ],
          },
        }
      )

      const proc = run(
        './node_modules/.bin/playwright test -c playwright.config.js',
        {
          cwd: runtime.cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            PW_BASE_URL: `http://localhost:${runtime.webAppPort}`,
          },
        }
      )

      const eventsPromise = receiver
        .gatherPayloadsUntilChildExit(proc, ({ url }) => url === '/api/v2/citestcycle', (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          const newTests = tests.filter(test =>
            test.resource.endsWith('should work with passing tests')
          )
          // new tests detected but no retries
          newTests.forEach(test => {
            assertObjectContains(test.meta, {
              [TEST_IS_NEW]: 'true',
            })
          })

          const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(retriedTests.length, 0)
        })

      const [[exitCode]] = await Promise.all([once(proc, 'exit'), eventsPromise])
      // The default fixture includes a known failing test.
      assert.strictEqual(exitCode, 1)
    })
  })

  contextNewVersions('test management', () => {
    const ATTEMPT_TO_FIX_NUM_RETRIES = 3

    context('attempt to fix', () => {
      const getTestAssertions = (receiver, {
        isAttemptingToFix,
        shouldAlwaysPass,
        shouldFailSometimes,
        isDisabled,
        isQuarantined,
        shouldIncludeFlakyTest,
        shouldNotUseEfd,
      }) =>
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            if (isAttemptingToFix) {
              assertObjectContains(testSession.meta, {
                [TEST_MANAGEMENT_ENABLED]: 'true',
              })
            } else {
              assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
            }

            const attemptedToFixTests = tests.filter(
              test => test.meta[TEST_NAME].startsWith('attempt to fix should attempt to fix')
            )

            if (shouldNotUseEfd) {
              const originalTests = attemptedToFixTests.filter(test => test.meta[TEST_IS_RETRY] !== 'true')
              assert.ok(originalTests.every(test => test.meta[TEST_IS_NEW] === 'true'))
              assert.ok(attemptedToFixTests.every(
                test => test.meta[TEST_RETRY_REASON] !== TEST_RETRY_REASON_TYPES.efd
              ))
            }

            if (isDisabled && !isAttemptingToFix) {
              assert.strictEqual(attemptedToFixTests.length, 2)
              assert.ok(
                attemptedToFixTests.every(test => test.meta[TEST_MANAGEMENT_IS_DISABLED] === 'true'),
                `Got: ${inspect(attemptedToFixTests.map(t => t.meta[TEST_MANAGEMENT_IS_DISABLED]))}`
              )
              // if the test is disabled and not attempting to fix, there will be no retries
              return
            }

            if (isAttemptingToFix) {
              assert.strictEqual(attemptedToFixTests.length, 2 * (ATTEMPT_TO_FIX_NUM_RETRIES + 1))
            } else {
              assert.strictEqual(attemptedToFixTests.length, 2)
            }

            if (isDisabled) {
              const numDisabledTests = attemptedToFixTests.filter(test =>
                test.meta[TEST_MANAGEMENT_IS_DISABLED] === 'true'
              ).length
              // disabled tests with attemptToFix still run and are retried
              assert.strictEqual(numDisabledTests, 2 * (ATTEMPT_TO_FIX_NUM_RETRIES + 1))
              // disabled tests with attemptToFix should not be skipped - they should run with pass/fail status
              const skippedDisabledTests = attemptedToFixTests.filter(test =>
                test.meta[TEST_MANAGEMENT_IS_DISABLED] === 'true' &&
                test.meta[TEST_STATUS] === 'skip'
              ).length
              assert.strictEqual(skippedDisabledTests, 0, 'disabled tests with attemptToFix should not be skipped')
            }

            if (isQuarantined) {
              const numQuarantinedTests = attemptedToFixTests.filter(test =>
                test.meta[TEST_MANAGEMENT_IS_QUARANTINED] === 'true'
              ).length
              // quarantined tests still run and are retried
              assert.strictEqual(numQuarantinedTests, 2 * (ATTEMPT_TO_FIX_NUM_RETRIES + 1))
            }

            // Retried tests are in randomly order, so we just count number of tests
            const countAttemptToFixTests = attemptedToFixTests.filter(test =>
              test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX] === 'true'
            ).length

            const countRetriedAttemptToFixTests = attemptedToFixTests.filter(test =>
              test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX] === 'true' &&
              test.meta[TEST_IS_RETRY] === 'true' &&
              test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atf
            ).length

            const testsMarkedAsFailedAllRetries = attemptedToFixTests.filter(test =>
              test.meta[TEST_HAS_FAILED_ALL_RETRIES] === 'true'
            )

            const testsMarkedAsPassedAllRetries = attemptedToFixTests.filter(test =>
              test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED] === 'true'
            ).length

            const testsMarkedAsFailed = attemptedToFixTests.filter(test =>
              test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED] === 'false'
            ).length

            // One of the tests is passing always
            if (isAttemptingToFix) {
              assert.strictEqual(countAttemptToFixTests, 2 * (ATTEMPT_TO_FIX_NUM_RETRIES + 1))
              assert.strictEqual(countRetriedAttemptToFixTests, 2 * ATTEMPT_TO_FIX_NUM_RETRIES)
              if (shouldAlwaysPass) {
                assert.strictEqual(testsMarkedAsFailedAllRetries.length, 0)
                assert.strictEqual(testsMarkedAsFailed, 0)
                assert.strictEqual(testsMarkedAsPassedAllRetries, 2)
              } else if (shouldFailSometimes) {
                // one test failed sometimes, the other always passed
                assert.strictEqual(testsMarkedAsFailedAllRetries.length, 0)
                assert.strictEqual(testsMarkedAsFailed, 1)
                assert.strictEqual(testsMarkedAsPassedAllRetries, 1)
              } else {
                // one test failed always, the other always passed
                assert.strictEqual(
                  testsMarkedAsFailedAllRetries.length,
                  1,
                  JSON.stringify(testsMarkedAsFailedAllRetries.map(test => ({
                    name: test.meta[TEST_NAME],
                    status: test.meta[TEST_STATUS],
                  })))
                )
                assert.strictEqual(testsMarkedAsFailed, 1)
                assert.strictEqual(testsMarkedAsPassedAllRetries, 1)
              }

              // Exactly one ATF run has TEST_FINAL_STATUS; all others must not.
              // We avoid sorting by start time because parallel workers make
              // wall-clock order non-deterministic.
              for (const testName of [
                'attempt to fix should attempt to fix failed test',
                'attempt to fix should attempt to fix passed test',
              ]) {
                let expectedFinalStatus
                if (isDisabled || isQuarantined) {
                  expectedFinalStatus = 'skip'
                } else if (shouldAlwaysPass ||
                  testName === 'attempt to fix should attempt to fix passed test') {
                  expectedFinalStatus = 'pass'
                } else {
                  expectedFinalStatus = 'fail'
                }

                const group = attemptedToFixTests.filter(t => t.meta[TEST_NAME] === testName)
                const finalRuns = group.filter(t => TEST_FINAL_STATUS in t.meta)
                assert.strictEqual(finalRuns.length, 1,
                  `Exactly one ATF run of "${testName}" should have TEST_FINAL_STATUS, got ${finalRuns.length}`)
                assert.strictEqual(finalRuns[0].meta[TEST_FINAL_STATUS], expectedFinalStatus)
                const nonFinalRuns = group.filter(t => !(TEST_FINAL_STATUS in t.meta))
                assert.strictEqual(nonFinalRuns.length, group.length - 1,
                  `All other ATF runs of "${testName}" should not have TEST_FINAL_STATUS`)
              }
            } else {
              assert.strictEqual(countAttemptToFixTests, 0)
              assert.strictEqual(countRetriedAttemptToFixTests, 0)
              assert.strictEqual(testsMarkedAsFailedAllRetries.length, 0)
              assert.strictEqual(testsMarkedAsPassedAllRetries, 0)
            }
            if (shouldIncludeFlakyTest) {
              const flakyTests = tests.filter(
                test => test.meta[TEST_NAME] === 'flaky test is retried without attempt to fix'
              )
              // it passes at the second attempt
              assert.strictEqual(flakyTests.length, 2)
              const passedFlakyTest = flakyTests.filter(test => test.meta[TEST_STATUS] === 'pass')
              const failedFlakyTest = flakyTests.filter(test => test.meta[TEST_STATUS] === 'fail')
              assert.strictEqual(passedFlakyTest.length, 1)
              assert.strictEqual(failedFlakyTest.length, 1)
            }
          }, PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT)

      /**
       * @param {import('../ci-visibility-intake').FakeCiVisIntake} receiver
       * @param {{
       *   isAttemptingToFix?: boolean,
       *   isQuarantined?: boolean,
       *   extraEnvVars?: Record<string, string>,
       *   shouldAlwaysPass?: boolean,
       *   shouldFailSometimes?: boolean,
       *   isDisabled?: boolean,
       *   shouldIncludeFlakyTest?: boolean,
       *   shouldNotUseEfd?: boolean,
       *   cliArgs?: string
       * }} [options]
       */
      const runAttemptToFixTest = async (receiver, {
        isAttemptingToFix,
        isQuarantined,
        extraEnvVars,
        shouldAlwaysPass,
        shouldFailSometimes,
        isDisabled,
        shouldIncludeFlakyTest,
        shouldNotUseEfd,
        cliArgs = 'attempt-to-fix-test.js',
      } = {}) => {
        const testAssertionsPromise = getTestAssertions(receiver, {
          isAttemptingToFix,
          shouldAlwaysPass,
          shouldFailSometimes,
          isDisabled,
          isQuarantined,
          shouldIncludeFlakyTest,
          shouldNotUseEfd,
        })
        let stdout = ''
        let proc
        try {
          proc = exec(
            `./node_modules/.bin/playwright test -c playwright.config.js ${cliArgs}`,
            {
              cwd: runtime.cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${runtime.webAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-test-management',
                ...(shouldAlwaysPass ? { SHOULD_ALWAYS_PASS: '1' } : {}),
                ...(shouldFailSometimes ? { SHOULD_FAIL_SOMETIMES: '1' } : {}),
                ...(shouldIncludeFlakyTest ? { SHOULD_INCLUDE_FLAKY_TEST: '1' } : {}),
                ...extraEnvVars,
              },
            }
          )

          proc.stdout?.on('data', data => { stdout += data })
          proc.stderr?.on('data', data => { stdout += data })

          const [[exitCode]] = await Promise.all([
            once(proc, 'exit'),
            testAssertionsPromise,
          ])

          if (isAttemptingToFix) {
            assert.match(stdout, /Datadog Test Optimization: attempting to fix .*should attempt to fix failed test/)
            assert.strictEqual(
              (stdout.match(
                /Datadog Test Optimization: attempting to fix .*should attempt to fix failed test/g
              ) || []).length,
              1
            )
            assert.match(stdout, /Datadog Test Optimization/)
            if (shouldAlwaysPass) {
              assert.match(stdout, /Attempt to fix passed/)
            } else {
              assert.match(stdout, /Attempt to fix failed/)
              assert.doesNotMatch(stdout, /executions? [\d, -]+:/)
            }
            if (isQuarantined || isDisabled) {
              assert.doesNotMatch(stdout, /Errors are suppressed because this test is/)
            }
          }

          if (shouldAlwaysPass) {
            assert.strictEqual(exitCode, 0)
          } else {
            assert.strictEqual(exitCode, 1)
          }
        } finally {
          proc?.kill()
        }
      }

      it('can attempt to fix and mark last attempt as failed if every attempt fails', async (receiver) => {
        receiver.setTestManagementTests(ATF_MANAGEMENT_TESTS)
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
        })
        await runAttemptToFixTest(receiver, { isAttemptingToFix: true })
      })

      it('can attempt to fix and mark last attempt as passed if every attempt passes', async (receiver) => {
        receiver.setTestManagementTests(ATF_MANAGEMENT_TESTS)
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
        })
        await runAttemptToFixTest(receiver, { isAttemptingToFix: true, shouldAlwaysPass: true })
      })

      it('can attempt to fix and not mark last attempt if attempts both pass and fail', async (receiver) => {
        receiver.setTestManagementTests(ATF_MANAGEMENT_TESTS)
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
        })
        await runAttemptToFixTest(receiver, { isAttemptingToFix: true, shouldFailSometimes: true })
      })

      it('does not attempt to fix tests if test management is not enabled', async (receiver) => {
        receiver.setTestManagementTests(ATF_MANAGEMENT_TESTS)
        receiver.setSettings({
          test_management: { enabled: false, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
        })
        await runAttemptToFixTest(receiver)
      })

      it('does not enable attempt to fix tests if DD_TEST_MANAGEMENT_ENABLED is set to false', async (receiver) => {
        receiver.setTestManagementTests(ATF_MANAGEMENT_TESTS)
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
        })
        await runAttemptToFixTest(receiver, { extraEnvVars: { DD_TEST_MANAGEMENT_ENABLED: '0' } })
      })

      it('does not tag known attempt to fix tests as new', async (receiver, run) => {
        receiver.setTestManagementTests(ATF_MANAGEMENT_TESTS)
        receiver.setKnownTests({
          playwright: {
            'attempt-to-fix-test.js': [
              'attempt to fix should attempt to fix failed test',
              'attempt to fix should attempt to fix passed test',
            ],
          },
        })
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: 2 },
          early_flake_detection: {
            enabled: true,
            slow_test_retries: { '5s': 2 },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const atfTests = tests.filter(
              t => t.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX] === 'true'
            )
            assert.ok(atfTests.length > 0, `Expected ${atfTests.length} > 0`)
            for (const test of atfTests) {
              assert.ok(
                !(TEST_IS_NEW in test.meta),
                'ATF test that is in known tests should not be tagged as new'
              )
            }
          }, PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT)

        const proc = run(
          './node_modules/.bin/playwright test -c playwright.config.js attempt-to-fix-test.js',
          {
            cwd: runtime.cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${runtime.webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-test-management',
            },
          }
        )

        await Promise.all([once(proc, 'exit'), eventsPromise])
      })

      it('ignores quarantine when attempting to fix a test', async (receiver) => {
        receiver.setTestManagementTests({
          playwright: {
            suites: {
              'attempt-to-fix-test.js': {
                tests: {
                  'attempt to fix should attempt to fix failed test': {
                    properties: {
                      attempt_to_fix: true,
                      quarantined: true,
                    },
                  },
                  'attempt to fix should attempt to fix passed test': {
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
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
        })
        await runAttemptToFixTest(receiver, { isAttemptingToFix: true, isQuarantined: true })
      })

      it('does not run EFD for a new attempt to fix test', async (receiver) => {
        receiver.setTestManagementTests({
          playwright: {
            suites: {
              'attempt-to-fix-test.js': {
                tests: {
                  'attempt to fix should attempt to fix failed test': {
                    properties: {
                      attempt_to_fix: true,
                      quarantined: true,
                    },
                  },
                  'attempt to fix should attempt to fix passed test': {
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
        receiver.setKnownTests({ playwright: {} })
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
          early_flake_detection: {
            enabled: true,
            slow_test_retries: { '5s': 2 },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        await runAttemptToFixTest(receiver, {
          isAttemptingToFix: true,
          isQuarantined: true,
          shouldNotUseEfd: true,
        })
      })

      it('ignores disabled when attempting to fix a test', async (receiver) => {
        receiver.setTestManagementTests({
          playwright: {
            suites: {
              'attempt-to-fix-test.js': {
                tests: {
                  'attempt to fix should attempt to fix failed test': {
                    properties: {
                      attempt_to_fix: true,
                      disabled: true,
                    },
                  },
                  'attempt to fix should attempt to fix passed test': {
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
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
        })
        await runAttemptToFixTest(receiver, { isAttemptingToFix: true, isDisabled: true })
      })

      it('reports a skipped disabled attempt to fix test once per execution', async (receiver, run) => {
        const testName = 'skipped disabled attempt to fix'
        receiver.setTestManagementTests({
          playwright: {
            suites: {
              'attempt-to-fix-test.js': {
                tests: {
                  [testName]: {
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
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
        })

        const testAssertionsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events
              .filter(event => event.type === 'test')
              .map(event => event.content)
              .filter(test => test.meta[TEST_NAME] === testName)

            assert.strictEqual(tests.length, ATTEMPT_TO_FIX_NUM_RETRIES + 1)
            for (const test of tests) {
              assert.strictEqual(test.meta[TEST_STATUS], 'skip')
              assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
              assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
            }
          }, PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT)

        const proc = run(
          './node_modules/.bin/playwright test -c playwright.config.js attempt-to-fix-test.js',
          {
            cwd: runtime.cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: './ci-visibility/playwright-tests-test-management',
              SHOULD_ALWAYS_PASS: '1',
              SHOULD_INCLUDE_SKIPPED_TEST: '1',
            },
          }
        )
        let testOutput = ''
        proc.stdout?.on('data', chunk => { testOutput += chunk.toString() })
        proc.stderr?.on('data', chunk => { testOutput += chunk.toString() })

        const [[exitCode]] = await Promise.all([
          once(proc, 'exit'),
          once(proc.stdout, 'end'),
          once(proc.stderr, 'end'),
          testAssertionsPromise,
        ])

        assert.doesNotMatch(testOutput, /SHOULD NOT BE EXECUTED/)
        assert.match(testOutput, /Attempt to fix passed: all 4 execution\(s\) passed for 1 test\(s\)\./)
        assert.doesNotMatch(testOutput, /Disabled:/)
        assert.strictEqual(exitCode, 0, testOutput)
      })

      it('reports an attempt to fix test skipped by a failed project dependency', async (receiver, run) => {
        receiver.setTestManagementTests({
          playwright: {
            suites: {
              'did-not-run.js': {
                tests: {
                  'did not run because of early bail': {
                    properties: { attempt_to_fix: true },
                  },
                },
              },
            },
          },
        })
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: 0 },
        })

        const proc = run(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd: runtime.cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: './ci-visibility/playwright-did-not-run',
              ADD_EXTRA_PLAYWRIGHT_PROJECT: 'true',
            },
          }
        )
        let testOutput = ''
        proc.stdout?.on('data', chunk => { testOutput += chunk.toString() })
        proc.stderr?.on('data', chunk => { testOutput += chunk.toString() })

        const [[exitCode]] = await Promise.all([
          once(proc, 'exit'),
          once(proc.stdout, 'end'),
          once(proc.stderr, 'end'),
        ])

        assert.match(testOutput, /Attempt to fix passed: all 1 execution\(s\) passed for 1 test\(s\)\./)
        assert.strictEqual(exitCode, 1, testOutput)
      })

      it('--retries is disabled for an attempt to fix test', async (receiver) => {
        receiver.setTestManagementTests(ATF_MANAGEMENT_TESTS)
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
        })
        await runAttemptToFixTest(receiver, {
          isAttemptingToFix: true,
          shouldFailSometimes: true,
          // passing retries has no effect
          cliArgs: 'attempt-to-fix-test.js --retries=20',
          shouldIncludeFlakyTest: true,
        })
      })

      it('ATR is disabled for an attempt to fix test', async (receiver) => {
        receiver.setTestManagementTests(ATF_MANAGEMENT_TESTS)
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
          flaky_test_retries_enabled: true,
        })
        await runAttemptToFixTest(receiver, {
          isAttemptingToFix: true,
          shouldFailSometimes: true,
          extraEnvVars: { DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '20' },
          shouldIncludeFlakyTest: true,
        })
      })
    })

    it('does not crash if the request to get test management tests fails', async (receiver, run) => {
      let testOutput = ''
      receiver.setSettings({
        test_management: { enabled: true },
        flaky_test_retries_enabled: false,
      })
      receiver.setTestManagementTestsResponseCode(500)

      // Playwright runs are slow (browser startup); need longer than default 15s to receive test_session_end
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSessionEnd = events.find(event => event.type === 'test_session_end')
            assert.ok(testSessionEnd, 'expected test_session_end event in payloads')
            const testSession = testSessionEnd.content
            assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            // they are not retried
            assert.strictEqual(tests.length, 2)
            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)
          },
          120000
        )

      const proc = run(
        './node_modules/.bin/playwright test -c playwright.config.js attempt-to-fix-test.js',
        {
          cwd: runtime.cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            PW_BASE_URL: `http://localhost:${runtime.webAppPort}`,
            TEST_DIR: './ci-visibility/playwright-tests-test-management',
            DD_TRACE_DEBUG: '1',
          },
        }
      )

      proc.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      proc.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })

      await Promise.all([
        once(proc, 'exit'),
        once(proc.stdout, 'end'),
        once(proc.stderr, 'end'),
        eventsPromise,
      ])
      assert.match(testOutput, /Test management tests could not be fetched/)
    })
  })
})
