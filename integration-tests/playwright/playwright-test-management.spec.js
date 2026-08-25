'use strict'

const assert = require('node:assert')
const { once } = require('node:events')
const { inspect } = require('node:util')
const { exec } = require('child_process')
const satisfies = require('semifies')

const {
  sandboxCwd,
  useSandbox,
  installPlaywrightChromium,
  getCiVisAgentlessConfig,
  assertObjectContains,
  createParallelIt,
} = require('../helpers')
const { createWebAppServer } = require('../ci-visibility/web-app-server')
const {
  TEST_STATUS,
  TEST_FINAL_STATUS,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ABORT_REASON,
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
  TEST_FAILURE_SCREENSHOT_UPLOADED,
  TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR,
} = require('../../packages/dd-trace/src/plugins/util/test')

const { PLAYWRIGHT_VERSION } = process.env

const PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT = 60000

const { getLatestPlaywrightSpecifier, oldest } = require('./versions')
const latest = getLatestPlaywrightSpecifier()
const versions = [oldest, latest]

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

const DISABLED_MANAGEMENT_TESTS = {
  playwright: {
    suites: {
      'disabled-test.js': {
        tests: {
          'disable should disable test': {
            properties: {
              disabled: true,
            },
          },
        },
      },
      'disabled-2-test.js': {
        tests: {
          'disable should disable test': {
            properties: {
              disabled: true,
            },
          },
        },
      },
      'disabled-serial-test.js': {
        tests: {
          'disabled serial retry should not run disabled sibling': {
            properties: {
              disabled: true,
            },
          },
        },
      },
    },
  },
}

const QUARANTINE_MANAGEMENT_TESTS = {
  playwright: {
    suites: {
      'quarantine-test.js': {
        tests: {
          'quarantine should quarantine failed test': {
            properties: {
              quarantined: true,
            },
          },
        },
      },
    },
  },
}

const QUARANTINE_WITH_DISABLED_ATF_MANAGEMENT_TESTS = {
  playwright: {
    suites: {
      ...QUARANTINE_MANAGEMENT_TESTS.playwright.suites,
      'zzz-passing-test.js': {
        tests: {
          'should run unless max failures is reached': {
            properties: {
              attempt_to_fix: true,
              disabled: true,
            },
          },
        },
      },
    },
  },
}

versions.forEach((version) => {
  if (PLAYWRIGHT_VERSION === 'oldest' && version !== oldest) return
  if (PLAYWRIGHT_VERSION === 'latest' && version !== latest) return

  // TODO: Remove this once we drop suppport for v5
  const contextNewVersions = satisfies(version, '>=1.38.0') || version === 'latest' ? context : context.skip

  describe(`playwright@${version}`, function () {
    const it = createParallelIt(global.it, { withReceiver: true })

    let cwd, webAppPort, webAppServer

    this.timeout(120000)

    useSandbox([`@playwright/test@${version}`, '@types/node', 'typescript'], true)

    before(function (done) {
      // Increase timeout for this hook specifically to account for slow chromium installation in CI
      this.timeout(120000)

      cwd = sandboxCwd()
      installPlaywrightChromium(cwd)

      // Create fresh server instance to avoid issues with retries
      webAppServer = createWebAppServer()

      webAppServer.listen(0, (err) => {
        if (err) {
          return done(err)
        }
        webAppPort = webAppServer.address().port
        done()
      })
    })

    after(async () => {
      await new Promise(resolve => webAppServer.close(resolve))
    })

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
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
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
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  PW_BASE_URL: `http://localhost:${webAppPort}`,
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
                assert.doesNotMatch(stdout, /execution(?:s)? [\d, -]+:/)
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
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${webAppPort}`,
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
              cwd,
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
              cwd,
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

      context('disabled', () => {
        const getTestAssertions = (receiver, isDisabling) =>
          receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const resourceNames = events.filter(event => event.type === 'test').map(event => event.content.resource)
              assertObjectContains(resourceNames.sort(), [
                'disabled-test.js.disable should disable test',
                'disabled-test.js.not disabled should not disable test',
                'disabled-test.js.not disabled 2 should not disable test 2',
                'disabled-test.js.not disabled 3 should not disable test 3',
                'disabled-2-test.js.disable should disable test',
                'disabled-2-test.js.not disabled should not disable test',
                'disabled-2-test.js.not disabled 2 should not disable test 2',
                'disabled-2-test.js.not disabled 3 should not disable test 3',
              ].sort())

              const testSession = events.find(event => event.type === 'test_session_end').content
              if (isDisabling) {
                assertObjectContains(testSession.meta, {
                  [TEST_MANAGEMENT_ENABLED]: 'true',
                })
              } else {
                assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
              }

              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              assert.strictEqual(tests.length, 8)

              const disabledTests = tests.filter(test => test.meta[TEST_NAME] === 'disable should disable test')
              assert.strictEqual(disabledTests.length, 2)

              disabledTests.forEach(test => {
                if (isDisabling) {
                  assert.strictEqual(test.meta[TEST_STATUS], 'skip')
                  assertObjectContains(test.meta, {
                    [TEST_MANAGEMENT_IS_DISABLED]: 'true',
                  })
                } else {
                  assert.strictEqual(test.meta[TEST_STATUS], 'fail')
                  assert.ok(!(TEST_MANAGEMENT_IS_DISABLED in test.meta))
                }
              })
            }, PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT)

        const runDisableTest = async (receiver, isDisabling, extraEnvVars) => {
          const testAssertionsPromise = getTestAssertions(receiver, isDisabling)
          let testOutput = ''
          let proc
          try {
            proc = exec(
              './node_modules/.bin/playwright test -c playwright.config.js disabled-test.js disabled-2-test.js',
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  PW_BASE_URL: `http://localhost:${webAppPort}`,
                  TEST_DIR: './ci-visibility/playwright-tests-test-management',
                  ...extraEnvVars,
                },
              }
            )

            proc.stdout?.on('data', (chunk) => {
              testOutput += chunk.toString()
            })
            proc.stderr?.on('data', (chunk) => {
              testOutput += chunk.toString()
            })

            const [[exitCode]] = await Promise.all([
              once(proc, 'exit'),
              once(proc.stdout, 'end'),
              once(proc.stderr, 'end'),
              testAssertionsPromise,
            ])

            // the testOutput checks whether the test is actually skipped
            if (isDisabling) {
              assert.doesNotMatch(testOutput, /SHOULD NOT BE EXECUTED/)
              assert.match(testOutput, /Disabled: \d+ tests? skipped\./)
              assert.strictEqual(exitCode, 0, testOutput)
            } else {
              assert.match(testOutput, /SHOULD NOT BE EXECUTED/)
              assert.strictEqual(exitCode, 1)
            }
          } finally {
            proc?.kill()
          }
        }

        it('can disable tests', async (receiver) => {
          receiver.setTestManagementTests(DISABLED_MANAGEMENT_TESTS)
          receiver.setSettings({ test_management: { enabled: true } })
          await runDisableTest(receiver, true)
        })

        it('can disable tests in fullyParallel mode', async (receiver) => {
          receiver.setTestManagementTests(DISABLED_MANAGEMENT_TESTS)
          receiver.setSettings({ test_management: { enabled: true } })
          await runDisableTest(receiver, true, { FULLY_PARALLEL: true, PLAYWRIGHT_WORKERS: '3' })
        })

        // Playwright itself only started ignoring unknown worker events in 1.39.0.
        if (version === latest || satisfies(version, '>=1.39.0')) {
          it('skips and reports a disabled sibling added by a serial retry', async (receiver, run) => {
            receiver.setTestManagementTests(DISABLED_MANAGEMENT_TESTS)
            receiver.setSettings({ test_management: { enabled: true } })

            const testAssertionsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
                const disabledTestName = 'disabled serial retry should not run disabled sibling'
                const events = payloads.flatMap(({ payload }) => payload.events)
                const disabledTests = events
                  .filter(event => event.type === 'test')
                  .map(event => event.content)
                  .filter(test => test.meta[TEST_NAME] === disabledTestName)

                assert.strictEqual(disabledTests.length, 1)
                assert.strictEqual(disabledTests[0].meta[TEST_STATUS], 'skip')
                assert.strictEqual(disabledTests[0].meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
              }, PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT)

            const proc = run(
              './node_modules/.bin/playwright test -c playwright.config.js disabled-serial-test.js --retries=1',
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  TEST_DIR: './ci-visibility/playwright-tests-test-management',
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
            assert.strictEqual(exitCode, 0, testOutput)
          })

          it('keeps failure screenshots aligned after a disabled serial retry sibling', async (receiver, run) => {
            receiver.setTestManagementTests(DISABLED_MANAGEMENT_TESTS)
            receiver.setSettings({ test_management: { enabled: true } })

            const proc = run(
              './node_modules/.bin/playwright test -c playwright.config.js disabled-serial-test.js --retries=1',
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  DD_TEST_FAILURE_SCREENSHOTS_ENABLED: 'true',
                  FAIL_AFTER_DISABLED: 'true',
                  PLAYWRIGHT_FAILURE_SCREENSHOT_MODE: 'only-on-failure',
                  PW_BASE_URL: `http://localhost:${webAppPort}`,
                  TEST_DIR: './ci-visibility/playwright-tests-test-management',
                },
              }
            )
            const payloadsPromise = receiver.gatherPayloadsUntilChildExit(
              proc,
              ({ url }) => url.startsWith('/api/v2/ci/test-runs/') || url.endsWith('/api/v2/citestcycle'),
              (payloads) => {
                const mediaPayloads = payloads.filter(({ url }) => url.startsWith('/api/v2/ci/test-runs/'))
                const failedTest = payloads
                  .filter(({ url }) => url.endsWith('/api/v2/citestcycle'))
                  .flatMap(({ payload }) => payload.events)
                  .filter(event => event.type === 'test')
                  .map(event => event.content)
                  .find(test => test.meta[TEST_NAME] ===
                    'disabled serial retry uploads screenshot after disabled sibling')

                assert.ok(failedTest)
                assert.strictEqual(failedTest.meta[TEST_FAILURE_SCREENSHOT_UPLOADED], 'true')
                assert.strictEqual(failedTest.meta[TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR], undefined)
                assert.strictEqual(mediaPayloads.length, 1)
              },
              { hardTimeout: PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT }
            )

            const [[exitCode]] = await Promise.all([once(proc, 'exit'), payloadsPromise])
            assert.strictEqual(exitCode, 1)
          })
        }

        it('fails if disable is not enabled', async (receiver) => {
          receiver.setTestManagementTests(DISABLED_MANAGEMENT_TESTS)
          receiver.setSettings({ test_management: { enabled: false } })
          await runDisableTest(receiver, false)
        })

        it('does not enable disable tests if DD_TEST_MANAGEMENT_ENABLED is set to false', async (receiver) => {
          receiver.setTestManagementTests(DISABLED_MANAGEMENT_TESTS)
          receiver.setSettings({ test_management: { enabled: true } })
          await runDisableTest(receiver, false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
        })
      })

      context('quarantine', () => {
        const getTestAssertions = (receiver, {
          isQuarantining,
          hasFlakyTests,
          expectedQuarantinedTestCount,
        }) =>
          receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSession = events.find(event => event.type === 'test_session_end').content

              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              const flakyTests = tests.filter(test => test.meta[TEST_NAME] === 'flaky should be flaky')
              const quarantinedTests = tests.filter(
                test => test.meta[TEST_NAME] === 'quarantine should quarantine failed test'
              )

              quarantinedTests.forEach(test => {
                assert.strictEqual(test.meta[TEST_STATUS], 'fail')
              })

              if (hasFlakyTests) {
                assert.strictEqual(flakyTests.length, 2) // first attempt fails, second attempt passes
                assert.strictEqual(quarantinedTests.length, 2) // both fail
                assert.ok(!(TEST_MANAGEMENT_IS_QUARANTINED in flakyTests[0].meta))
                assert.ok(!(TEST_MANAGEMENT_IS_QUARANTINED in flakyTests[1].meta))
                const failedFlakyTest = flakyTests.filter(test => test.meta[TEST_STATUS] === 'fail')
                const passedFlakyTest = flakyTests.filter(test => test.meta[TEST_STATUS] === 'pass')
                assert.strictEqual(failedFlakyTest.length, 1)
                assert.strictEqual(passedFlakyTest.length, 1)
              }

              if (isQuarantining) {
                if (hasFlakyTests) {
                  assert.strictEqual(quarantinedTests[1].meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
                } else {
                  assert.strictEqual(quarantinedTests.length, expectedQuarantinedTestCount)
                }
                assert.strictEqual(quarantinedTests[0].meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
                assertObjectContains(testSession.meta, {
                  [TEST_MANAGEMENT_ENABLED]: 'true',
                })
              } else {
                if (hasFlakyTests) {
                  assert.ok(!(TEST_MANAGEMENT_IS_QUARANTINED in quarantinedTests[1].meta))
                } else {
                  assert.strictEqual(quarantinedTests.length, 1)
                }
                assert.ok(!(TEST_MANAGEMENT_IS_QUARANTINED in quarantinedTests[0].meta))
                assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
              }
            }, PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT)

        /**
         * @param {import('../ci-visibility-intake').FakeCiVisIntake} receiver
         * @param {{
         *   isQuarantining?: boolean,
         *   extraEnvVars?: Record<string, string>,
         *   cliArgs?: string,
         *   hasFlakyTests?: boolean,
         *   expectedQuarantinedTestCount?: number
         * }} options
         */
        const runQuarantineTest = async (receiver, {
          isQuarantining,
          extraEnvVars,
          cliArgs = 'quarantine-test.js',
          hasFlakyTests = false,
          expectedQuarantinedTestCount = 1,
        }) => {
          const testAssertionsPromise = getTestAssertions(receiver, {
            isQuarantining,
            hasFlakyTests,
            expectedQuarantinedTestCount,
          })
          let testOutput = ''
          let proc
          try {
            proc = exec(
              `./node_modules/.bin/playwright test -c playwright.config.js ${cliArgs}`,
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  PW_BASE_URL: `http://localhost:${webAppPort}`,
                  TEST_DIR: './ci-visibility/playwright-tests-test-management',
                  ...extraEnvVars,
                },
              }
            )
            proc.stdout?.on('data', chunk => { testOutput += chunk.toString() })
            proc.stderr?.on('data', chunk => { testOutput += chunk.toString() })

            const [[exitCode]] = await Promise.all([
              once(proc, 'exit'),
              testAssertionsPromise,
            ])

            if (isQuarantining) {
              assert.match(
                testOutput,
                /Quarantined: \d+ tests? run; \d+ failures? did not affect the test session\./
              )
              assert.strictEqual(exitCode, 0)
            } else {
              assert.strictEqual(exitCode, 1)
            }
          } finally {
            proc?.kill()
          }
        }

        it('can quarantine tests', async (receiver) => {
          receiver.setTestManagementTests(QUARANTINE_MANAGEMENT_TESTS)
          receiver.setSettings({ test_management: { enabled: true } })
          await runQuarantineTest(receiver, { isQuarantining: true })
        })

        it('can quarantine each repeated test instance', async (receiver) => {
          receiver.setTestManagementTests(QUARANTINE_MANAGEMENT_TESTS)
          receiver.setSettings({ test_management: { enabled: true } })
          await runQuarantineTest(receiver, {
            isQuarantining: true,
            cliArgs: 'quarantine-test.js --repeat-each=2',
            expectedQuarantinedTestCount: 2,
          })
        })

        it('can quarantine tests when there are other flaky tests retried with --retries', async (receiver) => {
          receiver.setTestManagementTests(QUARANTINE_MANAGEMENT_TESTS)
          receiver.setSettings({ test_management: { enabled: true } })
          await runQuarantineTest(receiver, {
            isQuarantining: true,
            cliArgs: 'quarantine-test.js quarantine-2-test.js --retries=1',
            hasFlakyTests: true,
          })
        })

        it('can quarantine tests when there are other flaky tests retried with ATR', async (receiver) => {
          receiver.setTestManagementTests(QUARANTINE_MANAGEMENT_TESTS)
          receiver.setSettings({
            test_management: { enabled: true },
            flaky_test_retries_enabled: true,
          })
          await runQuarantineTest(receiver, {
            isQuarantining: true,
            cliArgs: 'quarantine-test.js quarantine-2-test.js',
            hasFlakyTests: true,
            extraEnvVars: { DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1' },
          })
        })

        const runQuarantineMustFailTest = async (receiver, {
          cliArgs = 'quarantine-test.js',
          extraEnvVars,
        }) => {
          receiver.setTestManagementTests(QUARANTINE_MANAGEMENT_TESTS)
          receiver.setSettings({ test_management: { enabled: true } })

          let testOutput = ''
          let proc
          try {
            proc = exec(
              `./node_modules/.bin/playwright test -c playwright.config.js ${cliArgs}`,
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  PW_BASE_URL: `http://localhost:${webAppPort}`,
                  TEST_DIR: './ci-visibility/playwright-tests-test-management',
                  ...extraEnvVars,
                },
              }
            )
            proc.stdout?.on('data', data => { testOutput += data.toString() })
            proc.stderr?.on('data', data => { testOutput += data.toString() })

            const eventsPromise = receiver
              .gatherPayloadsUntilChildExit(proc, ({ url }) => url === '/api/v2/citestcycle', (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const testSession = events.find(event => event.type === 'test_session_end').content

                assert.strictEqual(testSession.meta[TEST_STATUS], 'fail', testOutput)
              }, { hardTimeout: PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT })

            const [[exitCode]] = await Promise.all([
              once(proc, 'exit'),
              once(proc.stdout, 'end'),
              once(proc.stderr, 'end'),
              eventsPromise,
            ])
            assert.strictEqual(exitCode, 1, testOutput)
          } finally {
            proc?.kill()
          }
        }

        for (const hook of ['BEFORE', 'AFTER']) {
          it(`does not quarantine a ${hook.toLowerCase()}All failure in the quarantined suite`, async (receiver) => {
            await runQuarantineMustFailTest(receiver, {
              extraEnvVars: { [`FAIL_QUARANTINE_${hook}_ALL`]: '1' },
            })
          })
        }

        it('does not quarantine an expected failure that unexpectedly passes', async (receiver) => {
          await runQuarantineMustFailTest(receiver, {
            extraEnvVars: { EXPECTED_FAILURE_PASSES: '1' },
          })
        })

        if (version === 'latest' || satisfies(version, '>=1.52.0')) {
          it('does not quarantine a failure caused by failOnFlakyTests', async (receiver) => {
            await runQuarantineMustFailTest(receiver, {
              cliArgs: 'quarantine-test.js attempt-to-fix-test.js --retries=1',
              extraEnvVars: {
                FAIL_ON_FLAKY_TESTS: '1',
                SHOULD_ALWAYS_PASS: '1',
                SHOULD_INCLUDE_FLAKY_TEST: '1',
              },
            })
          })
        }

        const runEfdQuarantineTest = async (receiver, {
          durationRetryCount = 3,
          shouldUseCustomReporter = false,
          shouldFailBeforeAll = false,
          shouldFailGlobalTeardown = false,
          shouldReachMaxFailures = false,
          shouldPassRetries = false,
          shouldIncludeDisabledAttemptToFix = false,
        } = {}) => {
          const numRetries = 3
          receiver.setKnownTests({ playwright: {} })
          receiver.setTestManagementTests(shouldIncludeDisabledAttemptToFix
            ? QUARANTINE_WITH_DISABLED_ATF_MANAGEMENT_TESTS
            : QUARANTINE_MANAGEMENT_TESTS)
          receiver.setSettings({
            known_tests_enabled: true,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': durationRetryCount,
                '10s': durationRetryCount,
                '30s': durationRetryCount,
                '5m': numRetries,
              },
              faulty_session_threshold: 100,
            },
            test_management: {
              enabled: true,
              ...(shouldIncludeDisabledAttemptToFix ? { attempt_to_fix_retries: 0 } : {}),
            },
          })

          let testOutput = ''
          let proc
          try {
            proc = exec(
              './node_modules/.bin/playwright test -c playwright.config.js quarantine-test.js ' +
                (shouldFailBeforeAll ? 'failing-before-all-test.js ' : '') +
                (shouldReachMaxFailures ? 'zzz-passing-test.js' : ''),
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  ...(shouldUseCustomReporter ? { PLAYWRIGHT_FROZEN_REPORTER: '1' } : {}),
                  ...(shouldFailGlobalTeardown ? { FAIL_GLOBAL_TEARDOWN: '1' } : {}),
                  ...(shouldReachMaxFailures ? { MAX_FAILURES: '1', PLAYWRIGHT_WORKERS: '1' } : {}),
                  PW_BASE_URL: `http://localhost:${webAppPort}`,
                  TEST_DIR: './ci-visibility/playwright-tests-test-management',
                  ...(shouldPassRetries ? { SHOULD_PASS_EFD_RETRIES: '1' } : {}),
                },
              }
            )
            proc.stdout?.on('data', data => { testOutput += data.toString() })
            proc.stderr?.on('data', data => { testOutput += data.toString() })
            const eventsPromise = receiver
              .gatherPayloadsUntilChildExit(proc, ({ url }) => url === '/api/v2/citestcycle', (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const testSession = events.find(event => event.type === 'test_session_end').content
                const allTests = events
                  .filter(event => event.type === 'test')
                  .map(event => event.content)
                const tests = allTests
                  .filter(test => test.meta[TEST_NAME] === 'quarantine should quarantine failed test')

                assert.strictEqual(
                  testSession.meta[TEST_STATUS],
                  shouldFailBeforeAll || shouldFailGlobalTeardown || shouldReachMaxFailures ? 'fail' : 'pass'
                )
                if (shouldReachMaxFailures) {
                  assert.ok(tests.length >= 1 && tests.length <= numRetries + 1)
                  assert.ok(tests.some(test => test.meta[TEST_STATUS] === 'fail'))
                } else {
                  assert.strictEqual(tests.length, durationRetryCount + 1)
                  assert.strictEqual(
                    tests.filter(test => test.meta[TEST_STATUS] === 'fail').length,
                    shouldPassRetries ? 1 : durationRetryCount + 1
                  )
                  assert.strictEqual(
                    tests.filter(test => test.meta[TEST_STATUS] === 'pass').length,
                    shouldPassRetries ? durationRetryCount : 0
                  )
                }
                for (const test of tests) {
                  assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
                }
                if (shouldIncludeDisabledAttemptToFix) {
                  const disabledAttemptToFixTests = allTests.filter(
                    test => test.meta[TEST_NAME] === 'should run unless max failures is reached'
                  )
                  assert.strictEqual(disabledAttemptToFixTests.length, 1)
                  assert.strictEqual(disabledAttemptToFixTests[0].meta[TEST_STATUS], 'skip')
                  assert.strictEqual(disabledAttemptToFixTests[0].meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
                  assert.strictEqual(disabledAttemptToFixTests[0].meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
                }

                const retries = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
                assert.ok(retries.every(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd))

                const finalTests = tests.filter(test => TEST_FINAL_STATUS in test.meta)
                if (!shouldReachMaxFailures) {
                  assert.strictEqual(retries.length, durationRetryCount)
                  assert.strictEqual(finalTests.length, 1)
                  assert.strictEqual(finalTests[0].meta[TEST_FINAL_STATUS], 'skip')
                  assert.strictEqual(
                    finalTests[0].meta[TEST_EARLY_FLAKE_ABORT_REASON],
                    durationRetryCount === 0 ? 'slow' : undefined
                  )
                }
              }, { hardTimeout: PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT })

            const [[exitCode]] = await Promise.all([once(proc, 'exit'), eventsPromise])
            assert.match(testOutput, /Quarantined: 1 test run; 1 failure did not affect the test session\./)
            const shouldFail = shouldFailBeforeAll || shouldFailGlobalTeardown || shouldReachMaxFailures
            assert.strictEqual(exitCode, shouldFail ? 1 : 0, testOutput)
          } finally {
            proc?.kill()
          }
        }

        it('can quarantine a new test when all EFD attempts fail', async (receiver) => {
          await runEfdQuarantineTest(receiver)
        })

        it('ignores EFD clones outside a quarantined test retry budget', async (receiver) => {
          await runEfdQuarantineTest(receiver, { durationRetryCount: 1 })
        })

        it('ignores EFD clones after a quarantined test aborts slow retries', async (receiver) => {
          await runEfdQuarantineTest(receiver, { durationRetryCount: 0 })
        })

        it('can quarantine a new test with a custom reporter', async (receiver) => {
          await runEfdQuarantineTest(receiver, { shouldUseCustomReporter: true })
        })

        it('can quarantine a new test when an EFD retry passes', async (receiver) => {
          await runEfdQuarantineTest(receiver, { shouldPassRetries: true })
        })

        it('does not quarantine an independent hook failure when an EFD retry passes', async (receiver) => {
          await runEfdQuarantineTest(receiver, { shouldFailBeforeAll: true, shouldPassRetries: true })
        })

        it('does not quarantine a global teardown failure when an EFD retry passes', async (receiver) => {
          await runEfdQuarantineTest(receiver, { shouldFailGlobalTeardown: true, shouldPassRetries: true })
        })

        it('does not quarantine tests skipped after max failures is reached', async (receiver) => {
          await runEfdQuarantineTest(receiver, { shouldReachMaxFailures: true })
        })

        it('does not quarantine disabled attempt to fix tests skipped after max failures', async (receiver) => {
          await runEfdQuarantineTest(receiver, {
            shouldReachMaxFailures: true,
            shouldIncludeDisabledAttemptToFix: true,
          })
        })

        it('quarantines failures when a hook passes on a native retry', async (receiver) => {
          receiver.setTestManagementTests(QUARANTINE_MANAGEMENT_TESTS)
          receiver.setSettings({ test_management: { enabled: true } })

          let testOutput = ''
          let proc
          try {
            proc = exec(
              './node_modules/.bin/playwright test -c playwright.config.js ' +
                'quarantine-test.js flaky-before-all-test.js --retries=1',
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  PW_BASE_URL: `http://localhost:${webAppPort}`,
                  TEST_DIR: './ci-visibility/playwright-tests-test-management',
                },
              }
            )
            proc.stdout?.on('data', data => { testOutput += data.toString() })
            proc.stderr?.on('data', data => { testOutput += data.toString() })
            const eventsPromise = receiver
              .gatherPayloadsUntilChildExit(proc, ({ url }) => url === '/api/v2/citestcycle', (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const testSession = events.find(event => event.type === 'test_session_end').content

                assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')
              }, { hardTimeout: PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT })

            const [[exitCode]] = await Promise.all([once(proc, 'exit'), eventsPromise])
            assert.strictEqual(exitCode, 0, testOutput)
          } finally {
            proc?.kill()
          }
        })

        it('does not quarantine an independent hook failure when a native retry passes', async (receiver) => {
          receiver.setTestManagementTests(QUARANTINE_MANAGEMENT_TESTS)
          receiver.setSettings({ test_management: { enabled: true } })

          let testOutput = ''
          let proc
          try {
            proc = exec(
              './node_modules/.bin/playwright test -c playwright.config.js ' +
                'quarantine-test.js failing-before-all-test.js --retries=1',
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  PW_BASE_URL: `http://localhost:${webAppPort}`,
                  SHOULD_PASS_NATIVE_RETRIES: '1',
                  TEST_DIR: './ci-visibility/playwright-tests-test-management',
                },
              }
            )
            proc.stdout?.on('data', data => { testOutput += data.toString() })
            proc.stderr?.on('data', data => { testOutput += data.toString() })
            const eventsPromise = receiver
              .gatherPayloadsUntilChildExit(proc, ({ url }) => url === '/api/v2/citestcycle', (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const testSession = events.find(event => event.type === 'test_session_end').content
                const tests = events
                  .filter(event => event.type === 'test')
                  .map(event => event.content)
                  .filter(test => test.meta[TEST_NAME] === 'quarantine should quarantine failed test')

                assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
                assert.strictEqual(tests.length, 2)
                assert.strictEqual(tests.filter(test => test.meta[TEST_STATUS] === 'fail').length, 1)
                assert.strictEqual(tests.filter(test => test.meta[TEST_STATUS] === 'pass').length, 1)
                for (const test of tests) {
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
                }
              }, { hardTimeout: PLAYWRIGHT_TEST_MANAGEMENT_GATHER_TIMEOUT })

            const [[exitCode]] = await Promise.all([once(proc, 'exit'), eventsPromise])
            assert.strictEqual(exitCode, 1, testOutput)
          } finally {
            proc?.kill()
          }
        })

        it('fails if quarantine is not enabled', async (receiver) => {
          receiver.setTestManagementTests(QUARANTINE_MANAGEMENT_TESTS)
          receiver.setSettings({ test_management: { enabled: false } })
          await runQuarantineTest(receiver, { isQuarantining: false })
        })

        it('does not enable quarantine tests if DD_TEST_MANAGEMENT_ENABLED is set to false', async (receiver) => {
          receiver.setTestManagementTests(QUARANTINE_MANAGEMENT_TESTS)
          receiver.setSettings({ test_management: { enabled: true } })
          await runQuarantineTest(
            receiver,
            { isQuarantining: false, extraEnvVars: { DD_TEST_MANAGEMENT_ENABLED: '0' } }
          )
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
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
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
})
