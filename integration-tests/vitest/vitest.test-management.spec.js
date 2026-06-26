'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { exec } = require('child_process')
const { assertObjectContains } = require('../helpers')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  TEST_STATUS,
  TEST_IS_RETRY,
  TEST_IS_NEW,
  TEST_NAME,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_RETRY_REASON,
  DD_TEST_IS_USER_PROVIDED_SERVICE,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_RETRY_REASON_TYPES,
  TEST_FINAL_STATUS,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { NODE_MAJOR } = require('../../version')

// vitest@4.x requires Node.js >= 20
const versions = NODE_MAJOR <= 18 ? ['1.6.0', '3.2.6'] : ['1.6.0', 'latest']

versions.forEach((version) => {
  describe(`vitest@${version}`, () => {
    let cwd, receiver, childProcess
    const newerVitestIt = version === '1.6.0' ? it.skip : it

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
      childProcess.kill()
      await receiver.stop()
    })

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
            expectedExecutionCount,
            shouldAlwaysPass,
            shouldFailSometimes,
            shouldFailFirstOnly,
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
                ).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

                if (expectedExecutionCount !== undefined) {
                  assert.strictEqual(attemptedToFixTests.length, expectedExecutionCount)
                }

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
                      assert.ok(!(TEST_FINAL_STATUS in test.meta))
                      continue
                    }
                    assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
                    assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
                    if (isLastAttempt) {
                      if (shouldAlwaysPass) {
                        assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'true')
                      } else if (shouldFailSometimes || shouldFailFirstOnly) {
                        assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
                        assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in test.meta))
                      } else {
                        assert.strictEqual(test.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
                        assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
                      }
                      if (shouldAlwaysPass) {
                        assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'pass')
                      } else {
                        assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'fail')
                      }
                    } else {
                      // Intermediate ATF executions must not carry a final status tag
                      assert.ok(!(TEST_FINAL_STATUS in test.meta))
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
           *   expectedExecutionCount?: number,
           *   shouldAlwaysPass?: boolean,
           *   isQuarantining?: boolean,
           *   shouldFailSometimes?: boolean,
           *   shouldFailFirstOnly?: boolean,
           *   isDisabling?: boolean,
           *   extraEnvVars?: Record<string, string>,
           *   vitestCommand?: string
           * }} [options]
           */
          const runAttemptToFixTest = (done, {
            isAttemptingToFix,
            expectedExecutionCount,
            shouldAlwaysPass,
            isQuarantining,
            shouldFailSometimes,
            shouldFailFirstOnly,
            isDisabling,
            extraEnvVars = {},
            vitestCommand = './node_modules/.bin/vitest run',
          } = {}) => {
            let stdout = ''
            const testAssertionsPromise = getTestAssertions({
              isAttemptingToFix,
              expectedExecutionCount,
              shouldAlwaysPass,
              shouldFailSometimes,
              shouldFailFirstOnly,
              isQuarantining,
              isDisabling,
            })
            childProcess = exec(
              vitestCommand,
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  TEST_DIR: 'ci-visibility/vitest-tests/test-attempt-to-fix*',
                  NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
                  ...extraEnvVars,
                  ...(shouldAlwaysPass ? { SHOULD_ALWAYS_PASS: '1' } : {}),
                  ...(shouldFailSometimes ? { SHOULD_FAIL_SOMETIMES: '1' } : {}),
                  ...(shouldFailFirstOnly ? { SHOULD_FAIL_FIRST_ONLY: '1' } : {}),
                },
              }
            )

            childProcess.stdout?.on('data', (data) => {
              stdout += data
            })

            childProcess.stderr?.on('data', (data) => {
              stdout += data
            })

            childProcess.on('exit', (exitCode) => {
              testAssertionsPromise.then(() => {
                assert.match(stdout, /I am running/)
                if (expectedExecutionCount !== undefined) {
                  assert.strictEqual((stdout.match(/I am running/g) || []).length, expectedExecutionCount)
                }
                if (isAttemptingToFix) {
                  assert.match(
                    stdout,
                    /Datadog Test Optimization: attempting to fix .*attempt to fix tests can attempt to fix a test/
                  )
                  assert.strictEqual(
                    (stdout.match(
                      /Datadog Test Optimization: attempting to fix .*attempt to fix tests can attempt to fix a test/g
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
                  if (isQuarantining || isDisabling) {
                    assert.doesNotMatch(stdout, /Errors are suppressed because this test is/)
                  }
                }
                if (shouldAlwaysPass) {
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

          it('can attempt to fix when no-worker init is enabled', (done) => {
            receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

            runAttemptToFixTest(done, {
              isAttemptingToFix: true,
              expectedExecutionCount: 4,
              extraEnvVars: {
                DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT: 'true',
                EXPECT_DD_TEST_OPT_VITEST_SETUP_ENV_ABSENT: '1',
              },
            })
          })

          it('can attempt to fix and mark last attempt as passed if every attempt passes', (done) => {
            receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

            runAttemptToFixTest(done, { isAttemptingToFix: true, shouldAlwaysPass: true })
          })

          it('can attempt to fix and not mark last attempt if attempts both pass and fail', (done) => {
            receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

            runAttemptToFixTest(done, { isAttemptingToFix: true, shouldFailSometimes: true })
          })

          it('does not suppress exit code for plain ATF tests even when last retry passes', (done) => {
            receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

            runAttemptToFixTest(done, { isAttemptingToFix: true, shouldFailFirstOnly: true })
          })

          it('disables manual Vitest retries when attempting to fix a test', (done) => {
            receiver.setSettings({
              test_management: { enabled: true, attempt_to_fix_retries: 2 },
              flaky_test_retries_enabled: false,
            })

            runAttemptToFixTest(done, {
              isAttemptingToFix: true,
              shouldFailFirstOnly: true,
              expectedExecutionCount: 3,
              vitestCommand: './node_modules/.bin/vitest run --retry=1',
            })
          })

          it('records afterEach failures in attempt to fix summary', async () => {
            const testName = 'attempt to fix tests with failing afterEach ' +
              'can attempt to fix a test whose afterEach fails on the last attempt'
            receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
            receiver.setTestManagementTests({
              vitest: {
                suites: {
                  'ci-visibility/vitest-tests/hooks-attempt-to-fix-failing-after-each.mjs': {
                    tests: {
                      [testName]: {
                        properties: {
                          attempt_to_fix: true,
                        },
                      },
                    },
                  },
                },
              },
            })

            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                const attemptedToFixTests = tests
                  .filter(test => test.meta[TEST_NAME] === testName)
                  .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

                assert.strictEqual(attemptedToFixTests.length, 4)

                attemptedToFixTests.forEach((test, index) => {
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')

                  if (index < attemptedToFixTests.length - 1) {
                    assert.strictEqual(test.meta[TEST_STATUS], 'pass')
                    assert.ok(!(TEST_FINAL_STATUS in test.meta))
                    assert.ok(!(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED in test.meta))
                    assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in test.meta))
                  } else {
                    assert.strictEqual(test.meta[TEST_STATUS], 'fail')
                    assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'fail')
                    assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
                    assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in test.meta))
                  }
                })
              })

            let stdout = ''
            childProcess = exec(
              './node_modules/.bin/vitest run',
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  TEST_DIR: 'ci-visibility/vitest-tests/hooks-attempt-to-fix-failing-after-each.mjs',
                  NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
                },
              }
            )

            childProcess.stdout?.on('data', (data) => {
              stdout += data
            })
            childProcess.stderr?.on('data', (data) => {
              stdout += data
            })

            const [[exitCode]] = await Promise.all([
              once(childProcess, 'exit'),
              eventsPromise,
            ])

            assert.match(stdout, /Attempt to fix failed: 1 of 4 execution\(s\) failed across 1 of 1 test\(s\)\./)
            assert.strictEqual(exitCode, 1)
          })

          it('preserves raw attempt statuses for quarantined attempt to fix tests', (done) => {
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

            runAttemptToFixTest(done, {
              isAttemptingToFix: true,
              isQuarantining: true,
              shouldFailFirstOnly: true,
            })
          })

          it('does not attempt to fix tests if test management is not enabled', (done) => {
            receiver.setSettings({ test_management: { enabled: false, attempt_to_fix_retries: 3 } })

            runAttemptToFixTest(done)
          })

          it('does not enable attempt to fix tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
            receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

            runAttemptToFixTest(done, { extraEnvVars: { DD_TEST_MANAGEMENT_ENABLED: '0' } })
          })

          it('does not tag known attempt to fix tests as new', async () => {
            receiver.setKnownTests({
              vitest: {
                'ci-visibility/vitest-tests/test-attempt-to-fix.mjs': [
                  'attempt to fix tests can attempt to fix a test',
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
              })

            childProcess = exec(
              './node_modules/.bin/vitest run',
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  TEST_DIR: 'ci-visibility/vitest-tests/test-attempt-to-fix*',
                  NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
                },
              }
            )

            await Promise.all([
              once(childProcess, 'exit'),
              eventsPromise,
            ])
          })

          it('ignores quarantine when attempting to fix a test', (done) => {
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

          it('ignores disabled when attempting to fix a test', (done) => {
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

          it('reports passing disabled attempt to fix tests as passed', (done) => {
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

            runAttemptToFixTest(done, {
              isAttemptingToFix: true,
              isDisabling: true,
              shouldAlwaysPass: true,
            })
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

          newerVitestIt('can disable tests when no-worker init is enabled', (done) => {
            receiver.setSettings({ test_management: { enabled: true } })

            runDisableTest(done, true, {
              DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT: 'true',
              POOL_CONFIG: 'forks',
            })
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
                assert.strictEqual(tests.length, 3)

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
                    'ci-visibility/vitest-tests/test-quarantine.mjs.quarantine tests can quarantine a passing test',
                  ]
                )

                const quarantinedTest = tests.find(
                  test => test.meta[TEST_NAME] === 'quarantine tests can quarantine a test'
                )

                if (isQuarantining) {
                  assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
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

          newerVitestIt('can quarantine tests when no-worker init is enabled', (done) => {
            receiver.setSettings({ test_management: { enabled: true } })

            runQuarantineTest(done, true, {
              DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT: 'true',
            })
          })

          it('can quarantine tests retried by Vitest', async () => {
            receiver.setSettings({
              test_management: { enabled: true },
              flaky_test_retries_enabled: false,
            })

            const testAssertionsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                const testSession = events.find(event => event.type === 'test_session_end').content

                assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
                assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')

                const quarantinedTests = tests
                  .filter(test => test.meta[TEST_NAME] === 'quarantine tests can quarantine a test')
                  .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

                assert.strictEqual(quarantinedTests.length, 2)

                quarantinedTests.forEach((test, index) => {
                  assert.strictEqual(test.meta[TEST_STATUS], 'fail')
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')

                  if (index === 0) {
                    assert.ok(!(TEST_IS_RETRY in test.meta))
                    assert.ok(!(TEST_RETRY_REASON in test.meta))
                  } else {
                    assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
                    assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.ext)
                  }

                  if (index === quarantinedTests.length - 1) {
                    assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'skip')
                  } else {
                    assert.ok(!(TEST_FINAL_STATUS in test.meta))
                  }
                })
              })

            let stdout = ''
            childProcess = exec(
              './node_modules/.bin/vitest run --retry=1',
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  TEST_DIR: 'ci-visibility/vitest-tests/test-quarantine.mjs',
                  NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
                },
              }
            )
            childProcess.stdout?.on('data', data => {
              stdout += data
            })

            const [[exitCode]] = await Promise.all([
              once(childProcess, 'exit'),
              testAssertionsPromise,
            ])

            assert.strictEqual(
              (stdout.match(/I am running when quarantined/g) || []).length,
              2
            )
            assert.strictEqual(exitCode, 0)
          })

          it('can quarantine tests retried by Vitest that eventually pass', async () => {
            receiver.setSettings({
              test_management: { enabled: true },
              flaky_test_retries_enabled: false,
            })
            receiver.setTestManagementTests({
              vitest: {
                suites: {
                  'ci-visibility/vitest-tests/quarantine-eventually-passes.mjs': {
                    tests: {
                      'quarantine tests with retries can quarantine a test that eventually passes': {
                        properties: {
                          quarantined: true,
                        },
                      },
                    },
                  },
                },
              },
            })

            const testAssertionsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                const testSession = events.find(event => event.type === 'test_session_end').content

                assert.strictEqual(testSession.meta[TEST_MANAGEMENT_ENABLED], 'true')
                assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')

                const quarantinedTests = tests
                  .filter(test => test.meta[TEST_NAME] ===
                    'quarantine tests with retries can quarantine a test that eventually passes')
                  .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

                assert.strictEqual(quarantinedTests.length, 3)

                quarantinedTests.forEach((test, index) => {
                  assert.strictEqual(test.meta[TEST_STATUS], index === 2 ? 'pass' : 'fail')
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')

                  if (index === 0) {
                    assert.ok(!(TEST_IS_RETRY in test.meta))
                    assert.ok(!(TEST_RETRY_REASON in test.meta))
                  } else {
                    assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
                    assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.ext)
                  }

                  if (index === quarantinedTests.length - 1) {
                    assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'skip')
                  } else {
                    assert.ok(!(TEST_FINAL_STATUS in test.meta))
                  }
                })
              })

            let stdout = ''
            childProcess = exec(
              './node_modules/.bin/vitest run --retry=2',
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  TEST_DIR: 'ci-visibility/vitest-tests/quarantine-eventually-passes.mjs',
                  NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
                },
              }
            )
            childProcess.stdout?.on('data', data => {
              stdout += data
            })

            const [[exitCode]] = await Promise.all([
              once(childProcess, 'exit'),
              testAssertionsPromise,
            ])

            assert.strictEqual(
              (stdout.match(/I am running when quarantined and eventually passes/g) || []).length,
              3
            )
            assert.strictEqual(exitCode, 0)
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

          // Request module waits before retrying — need longer gather timeout
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSessionEnd = events.find(event => event.type === 'test_session_end')
              assert.ok(testSessionEnd, 'expected test_session_end event in payloads')
              const testSession = testSessionEnd.content
              assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              // it is not retried
              assert.strictEqual(tests.length, 1)
            }, 60000)

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
  })
})
