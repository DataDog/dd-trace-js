'use strict'

const assert = require('node:assert')
const { once } = require('node:events')
const { exec, execSync } = require('child_process')
const satisfies = require('semifies')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  assertObjectContains,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { createWebAppServer } = require('../ci-visibility/web-app-server')
const {
  TEST_STATUS,
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
const { DD_MAJOR } = require('../../version')

const { PLAYWRIGHT_VERSION } = process.env

const latest = 'latest'
const oldest = DD_MAJOR >= 6 ? '1.38.0' : '1.18.0'
const versions = [oldest, latest]

versions.forEach((version) => {
  if (PLAYWRIGHT_VERSION === 'oldest' && version !== oldest) return
  if (PLAYWRIGHT_VERSION === 'latest' && version !== latest) return

  // TODO: Remove this once we drop suppport for v5
  const contextNewVersions = (...args) => {
    if (satisfies(version, '>=1.38.0') || version === 'latest') {
      context(...args)
    }
  }

  describe(`playwright@${version}`, function () {
    let cwd, receiver, childProcess, webAppPort, webAppServer

    this.timeout(80000)

    useSandbox([`@playwright/test@${version}`, '@types/node', 'typescript'], true)

    before(function (done) {
      // Increase timeout for this hook specifically to account for slow chromium installation in CI
      this.timeout(120000)

      cwd = sandboxCwd()
      const { NODE_OPTIONS, ...restOfEnv } = process.env
      // Install chromium (configured in integration-tests/playwright.config.js)
      // *Be advised*: this means that we'll only be using chromium for this test suite
      // This will use cached browsers if available, otherwise download
      execSync('npx playwright install chromium', { cwd, env: restOfEnv, stdio: 'inherit' })

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

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async () => {
      childProcess.kill()
      await receiver.stop()
    })

    contextNewVersions('known tests without early flake detection', () => {
      it('detects new tests without retrying them', (done) => {
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

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
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

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
            },
          }
        )

        childProcess.on('exit', () => {
          receiverPromise.then(() => done()).catch(done)
        })
      })
    })

    contextNewVersions('test management', () => {
      const ATTEMPT_TO_FIX_NUM_RETRIES = 3
      context('attempt to fix', () => {
        beforeEach(() => {
          receiver.setTestManagementTests({
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
          })
        })

        const getTestAssertions = ({
          isAttemptingToFix,
          shouldAlwaysPass,
          shouldFailSometimes,
          isDisabled,
          isQuarantined,
          shouldIncludeFlakyTest,
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

              if (isDisabled && !isAttemptingToFix) {
                assert.strictEqual(attemptedToFixTests.length, 2)
                assert.ok(attemptedToFixTests.every(test =>
                  test.meta[TEST_MANAGEMENT_IS_DISABLED] === 'true'
                ))
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
            }, 30000)

        /**
         * @param {{
         *   isAttemptingToFix?: boolean,
         *   isQuarantined?: boolean,
         *   extraEnvVars?: Record<string, string>,
         *   shouldAlwaysPass?: boolean,
         *   shouldFailSometimes?: boolean,
         *   isDisabled?: boolean,
         *   shouldIncludeFlakyTest?: boolean,
         *   cliArgs?: string
         * }} [options]
         */
        const runAttemptToFixTest = async ({
          isAttemptingToFix,
          isQuarantined,
          extraEnvVars,
          shouldAlwaysPass,
          shouldFailSometimes,
          isDisabled,
          shouldIncludeFlakyTest,
          cliArgs = 'attempt-to-fix-test.js',
        } = {}) => {
          const testAssertionsPromise = getTestAssertions({
            isAttemptingToFix,
            shouldAlwaysPass,
            shouldFailSometimes,
            isDisabled,
            isQuarantined,
            shouldIncludeFlakyTest,
          })
          let stdout = ''

          childProcess = exec(
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

          childProcess.stdout?.on('data', data => {
            stdout += data
          })

          childProcess.stderr?.on('data', data => {
            stdout += data
          })

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
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
        }

        it('can attempt to fix and mark last attempt as failed if every attempt fails', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
          })

          await runAttemptToFixTest({ isAttemptingToFix: true })
        })

        it('can attempt to fix and mark last attempt as passed if every attempt passes', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
          })

          await runAttemptToFixTest({ isAttemptingToFix: true, shouldAlwaysPass: true })
        })

        it('can attempt to fix and not mark last attempt if attempts both pass and fail', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
          })

          await runAttemptToFixTest({ isAttemptingToFix: true, shouldFailSometimes: true })
        })

        it('does not attempt to fix tests if test management is not enabled', async () => {
          receiver.setSettings({
            test_management: { enabled: false, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
          })

          await runAttemptToFixTest()
        })

        it('does not enable attempt to fix tests if DD_TEST_MANAGEMENT_ENABLED is set to false', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
          })

          await runAttemptToFixTest({ extraEnvVars: { DD_TEST_MANAGEMENT_ENABLED: '0' } })
        })

        it('does not tag known attempt to fix tests as new', async () => {
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
              assert.ok(atfTests.length > 0)
              for (const test of atfTests) {
                assert.ok(
                  !(TEST_IS_NEW in test.meta),
                  'ATF test that is in known tests should not be tagged as new'
                )
              }
            })

          childProcess = exec(
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

          await Promise.all([
            once(childProcess, 'exit'),
            eventsPromise,
          ])
        })

        it('ignores quarantine when attempting to fix a test', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
          })
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

          await runAttemptToFixTest({ isAttemptingToFix: true, isQuarantined: true })
        })

        it('ignores disabled when attempting to fix a test', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
          })
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

          await runAttemptToFixTest({ isAttemptingToFix: true, isDisabled: true })
        })

        it('--retries is disabled for an attempt to fix test', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
          })

          await runAttemptToFixTest({
            isAttemptingToFix: true,
            shouldFailSometimes: true,
            // passing retries has no effect
            cliArgs: 'attempt-to-fix-test.js --retries=20',
            shouldIncludeFlakyTest: true,
          })
        })

        it('ATR is disabled for an attempt to fix test', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
            flaky_test_retries_enabled: true,
          })

          await runAttemptToFixTest({
            isAttemptingToFix: true,
            shouldFailSometimes: true,
            extraEnvVars: { DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '20' },
            shouldIncludeFlakyTest: true,
          })
        })
      })

      context('disabled', () => {
        let testOutput = ''
        beforeEach(() => {
          testOutput = ''
          receiver.setTestManagementTests({
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
              },
            },
          })
        })

        const getTestAssertions = (isDisabling) =>
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
            }, 25000)

        const runDisableTest = async (isDisabling, extraEnvVars) => {
          const testAssertionsPromise = getTestAssertions(isDisabling)

          childProcess = exec(
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

          childProcess.stdout?.on('data', (chunk) => {
            testOutput += chunk.toString()
          })
          childProcess.stderr?.on('data', (chunk) => {
            testOutput += chunk.toString()
          })

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            once(childProcess.stdout, 'end'),
            once(childProcess.stderr, 'end'),
            testAssertionsPromise,
          ])

          // the testOutput checks whether the test is actually skipped
          if (isDisabling) {
            assert.doesNotMatch(testOutput, /SHOULD NOT BE EXECUTED/)
            assert.strictEqual(exitCode, 0)
          } else {
            assert.match(testOutput, /SHOULD NOT BE EXECUTED/)
            assert.strictEqual(exitCode, 1)
          }
        }

        it('can disable tests', async () => {
          receiver.setSettings({ test_management: { enabled: true } })

          await runDisableTest(true)
        })

        it('can disable tests in fullyParallel mode', async () => {
          receiver.setSettings({ test_management: { enabled: true } })

          await runDisableTest(true, { FULLY_PARALLEL: true, PLAYWRIGHT_WORKERS: '3' })
        })

        it('fails if disable is not enabled', async () => {
          receiver.setSettings({ test_management: { enabled: false } })

          await runDisableTest(false)
        })

        it('does not enable disable tests if DD_TEST_MANAGEMENT_ENABLED is set to false', async () => {
          receiver.setSettings({ test_management: { enabled: true } })

          await runDisableTest(false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
        })
      })

      context('quarantine', () => {
        beforeEach(() => {
          receiver.setTestManagementTests({
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
          })
        })

        const getTestAssertions = ({ isQuarantining, hasFlakyTests }) =>
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
                  assert.strictEqual(quarantinedTests.length, 1)
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
            }, 25000)

        /**
         * @param {{
         *   isQuarantining?: boolean,
         *   extraEnvVars?: Record<string, string>,
         *   cliArgs?: string,
         *   hasFlakyTests?: boolean
         * }} options
         */
        const runQuarantineTest = async ({
          isQuarantining,
          extraEnvVars,
          cliArgs = 'quarantine-test.js',
          hasFlakyTests = false,
        }) => {
          const testAssertionsPromise = getTestAssertions({ isQuarantining, hasFlakyTests })

          childProcess = exec(
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

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            testAssertionsPromise,
          ])

          if (isQuarantining) {
            assert.strictEqual(exitCode, 0)
          } else {
            assert.strictEqual(exitCode, 1)
          }
        }

        it('can quarantine tests', async () => {
          receiver.setSettings({ test_management: { enabled: true } })

          await runQuarantineTest({ isQuarantining: true })
        })

        it('can quarantine tests when there are other flaky tests retried with --retries', async () => {
          receiver.setSettings({ test_management: { enabled: true } })

          await runQuarantineTest({
            isQuarantining: true,
            cliArgs: 'quarantine-test.js quarantine-2-test.js --retries=1',
            hasFlakyTests: true,
          })
        })

        it('can quarantine tests when there are other flaky tests retried with ATR', async () => {
          receiver.setSettings({
            test_management: { enabled: true },
            flaky_test_retries_enabled: true,
          })

          await runQuarantineTest({
            isQuarantining: true,
            cliArgs: 'quarantine-test.js quarantine-2-test.js',
            hasFlakyTests: true,
            extraEnvVars: { DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1' },
          })
        })

        it('fails if quarantine is not enabled', async () => {
          receiver.setSettings({ test_management: { enabled: false } })

          await runQuarantineTest({ isQuarantining: false })
        })

        it('does not enable quarantine tests if DD_TEST_MANAGEMENT_ENABLED is set to false', async () => {
          receiver.setSettings({ test_management: { enabled: true } })

          await runQuarantineTest({ isQuarantining: false, extraEnvVars: { DD_TEST_MANAGEMENT_ENABLED: '0' } })
        })
      })

      it('does not crash if the request to get test management tests fails', async () => {
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

        childProcess = exec(
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
  })
})
